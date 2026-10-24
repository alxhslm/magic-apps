# Code signing and local builds

`scripts/build-app.sh` builds every native artefact, signs each with one certificate, and refuses
to package a bundle with any of them missing. On Apple Silicon a binary with no signature does not run,
and an app extension whose team differs from its host does not load, so a build with no certificate
fails rather than producing a bundle that looks complete and does nothing.

## Building

```bash
pnpm run magimail:install  # build everything and replace /Applications/Magimail.app
pnpm run magimail          # build only, into apps/magimail/release/
```

Or, from `apps/magimail/`:

```bash
./scripts/build-app.sh --install         # full build + install
./scripts/build-app.sh --install --fast  # skip Swift/native/extension rebuilds
./scripts/build-app.sh --help
```

`--install` quits a running Magimail first and moves the old bundle to
`/tmp/Magimail-rollback-<timestamp>.app`. Accounts, settings and Gmail sessions live in
`~/Library/Application Support/Magimail`, so replacing the bundle never touches them.

`--fast` reuses the existing Swift helper, native dylib, N-API addon and the Share and Widget
extensions, which skips roughly two minutes of SwiftPM, node-gyp and xcodebuild work. Use it when
only TypeScript changed; drop it whenever anything under `swift/`, `native/`, `share-extension/` or
`widgets/` changed.

Even with `--fast` a packaged build takes ~2.5 minutes, because electron-builder re-extracts the
Electron runtime and re-runs `@electron/rebuild` every time. For iterating on TypeScript, use
`pnpm run dev` (`tsup --watch` plus `electron .`), which reloads in seconds. A packaged build verifies
the real bundle: the native helpers, the Share extension, the signature.

### Build script checks every artefact exists

Both apps build several native subsystems on top of the Electron main (`tsup`):

- **SwiftPM** builds the Swift helper and the toolbar dylib. The helper's `build.sh` also compiles
  its String Catalog with the same `xcstringstool` step the App Intents extension uses, because a
  helper is a bare executable and its strings resolve against the containing app's `Resources`.
- **node-gyp** builds the N-API addon.
- **xcodebuild** builds the Widget extension in both apps, and the Share extension in Magimail.
- **A bare `swiftc` invocation** builds the App Intents extension in both apps, which has no Xcode
  project of its own. It still needs a full Xcode to compile its String Catalog — `swiftc` has no
  equivalent step, so `build.sh` calls `compile_string_catalog` from `tools/localization.sh`, which
  runs `xcstringstool`.

`electron-builder.json` bundles them through `extraResources`/`extraFiles`, and when one of those
files is missing electron-builder only warns, then packages anyway:

```plain text
• file source doesn't exist  from=.../swift/.build/release/MagimailHelper
```

The result launches with no toolbar, no tray, no settings window and no notifications. A missing
`MagimailWidgets.appex` leaves nothing in the widget gallery at all, which is easy to read as a
broken widget rather than an absent one. Each script checks its own list and fails the build if any
artefact is absent, so a partial bundle cannot be produced by accident.

It checks the artefacts twice. Before packaging, every artefact must exist on disk. After
electron-builder returns, every `to:` destination in `electron-builder.json` must exist inside the
packaged `.app`. A file copied nowhere and a file copied to the wrong place leave the same working
build and the same dead feature, and which directory a file lands in decides whether macOS honours
it: the helper takes the app's bundle identity from `Contents/MacOS`, and an `.appex` outside
`Contents/PlugIns` is absent from the gallery rather than broken in it. The second list is written
out rather than read back from `electron-builder.json`, so a `to:` aimed at the wrong directory is
caught instead of followed.

Magical checks the same two ways over a shorter list of five native artefacts, because it has no
Share extension. Its App Intents extension is built by the same bare `swiftc` invocation as
Magimail's.

### Swift helper signs with the app's bundle id

`swift/build.sh` signs `MagimailHelper` with `--identifier com.alexhaslam.magimail`, the app's bundle
id rather than the identifier codesign would derive from the filename. `mac.signIgnore` then stops
electron-builder re-signing it back. The script also signs it with the App Group entitlement
(`swift/Helper.entitlements.in`, resolved from the certificate), because the helper reads
`focus-filter.json` from the group container the App Intents extension writes. Where no team resolves,
the group is dropped and the helper reads the pre-group file in Application Support instead.

Notifications depend on this. `usernoted` checks the signing identifier of the process asking to
post a notification against the bundle it claims to be, and the helper claims `Magimail.app` because
it ships in `Contents/MacOS`. Signed as `MagimailHelper`, `requestAuthorization` fails with
`UNErrorDomain Code=1`. The app never appears in System Settings → Notifications, no banner is ever
delivered, and nothing in the build output suggests anything is wrong. See
[`notifications.md`'s Bundle identity](notifications.md#bundle-identity).

## Three grades of signature

On Apple Silicon every binary must carry some signature or the kernel refuses to run it.

| Grade                                | Proves                                        | Result                                                 |
| :----------------------------------- | :-------------------------------------------- | :----------------------------------------------------- |
| **Ad-hoc** (`codesign -s -`)         | Nothing about the author; only detects tamper | Runs locally; Gatekeeper blocks it if ever quarantined |
| **Apple Development** (free account) | Built by you, for your own devices            | Runs on this Mac; will not open on someone else's      |
| **Developer ID Application** (paid)  | Apple-verified named developer                | Runs anywhere with no warnings, once notarised         |

A local build picks the best identity it finds: `Developer ID Application`, then `Apple
Distribution`, then `Apple Development`, then `Mac Developer`. Override it with `--identity "<name>"`
or `MAGIMAIL_SIGN_IDENTITY` (`MAGICAL_SIGN_IDENTITY` for Magical). An override naming a certificate
that is not installed is reported and ignored rather than trusted; trusting it fails minutes later
inside `codesign`, with an error that mentions neither the variable nor the fact that the name was
never checked.

`--dist` accepts only `Developer ID Application`. With no such certificate it stops at `assert_release_identity`
before compiling anything, rather than producing a bundle that opens only on the build Mac. `--adhoc`
still escapes, for exercising the packaging path without an Apple account.

[`../../tools/signing.sh`](../../tools/signing.sh) resolves the identity, and every script that
signs anything calls it: `build-app.sh`, `swift/build.sh` and each extension's `build.sh`. The
resolved identity signs the app bundle, the Electron framework, the dylib, the addon, the helper and
every extension, so the app and everything inside it carry one team. macOS validates an extension
against the host app's signature, so a team mismatch means the extension does not load, with no
message from macOS.

Each extension's `build.sh` also stamps the version from `apps/magimail/package.json` onto its
`.appex` before signing, so no extension claims a version its host does not. The checked-in
`Info.plist` values are only defaults.

### Focus filters need special treatment

Each app vends its Focus Filter from an App Intents extension: `MagimailAppIntents.appex` or
`MagicalAppIntents.appex`. App Intents is an ExtensionKit mechanism, so the bundle lives in
`Contents/Extensions`, while the Share and Widget extensions use the classic `NSExtension`
mechanism and live in `Contents/PlugIns`. That placement, and the bare `swiftc` build, give the
extension two quirks, and both fail silently.

**It keeps its own signature.** `electron-builder` re-signs every nested bundle inside the app
except those under `Contents/PlugIns`, which its signer skips by a built-in rule. It signs the rest
with the host's inherited entitlements (`mac.entitlementsInherit`). For `MagimailAppIntents.appex`
in `Contents/Extensions` that is fatal: it replaces `com.apple.security.app-sandbox` with
`com.apple.security.inherit`, and drops the App Group with it. `inherit` only means anything for a
child of a _sandboxed_ parent, and the Electron container is not sandboxed, so the extension ends up
with no sandbox at all. ExtensionKit refuses to launch an extension in that state, and the Focus UI
reports only "Could not load Focus Filter"; nothing names the entitlement.

`electron-builder.json` therefore carries:

```json
"signIgnore": ["Contents/Extensions/MagimailAppIntents\\.appex"]
```

so the signature applied by `app-intents-extension/build.sh` survives packaging. The outer app
signature still seals the appex, so the bundle stays valid. The Share and Widget extensions do not
need this: they live in `Contents/PlugIns` and keep their own signatures. Magical carries the same
entry for `MagicalAppIntents.appex`, for the same reason.

**It compiles its String Catalog with Xcode's tool.** An `.appex` localises with a String Catalog,
which macOS only reads once compiled into `.strings` and `.stringsdict`. An Xcode target does that
in its Resources phase, which is how both widget extensions ship theirs and how the Share extension
copies its already-readable `InfoPlist.strings`. This extension has no Xcode target, so its
`build.sh` runs `xcstringstool` through `compile_string_catalog` in `tools/localization.sh` — the
one part of the build that still needs full Xcode, and the reason `ensure_xcode` is called there.
SwiftPM cannot stand in: it copies a `.xcstrings` into the resource bundle uncompiled, so each
helper's `build.sh` compiles its own the same way and `electron-builder` copies the result into
`Contents/Resources`.

**It has an explicit entry point.** Both apps' `app-intents-extension/build.sh` compiles with a bare
`swiftc` rather than `xcodebuild`, so nothing sets the extension entry point for it. An `.appex` is
launched by the system and must hand control to Foundation's extension host loop. Without
`-e _NSExtensionMain`, `swiftc` emits its own `_main`, which returns immediately: the process exits
0 before the host connects, and the Focus UI again reports only "Could not load Focus Filter". Xcode
passes this flag for every extension target, which is why the Share and Widget extensions never hit
it.

### Hardened runtime

Both apps sign every Mach-O they ship with `--options runtime --timestamp`, because notarisation
refuses a bundle holding one without either, and the rejection names the requirement rather than the
file that broke it. `sign_hardened` in `tools/signing.sh` owns both options, so the helper, the
dylib, the addon and each extension cannot be signed without them. `--timestamp` needs the network
and a real certificate; under `--sign -` codesign ignores it instead of failing, so an ad-hoc build
needs no separate path, while offline with a certificate the build stops rather than producing
something Apple would reject.

`electron-builder.json` carries the other half, since electron-builder signs the app bundle, the
Electron framework, the dylib and the addon itself:

```json
"hardenedRuntime": true,
"entitlements": "build/.generated/entitlements.mac.plist",
"entitlementsInherit": "build/entitlements.mac.inherit.plist"
```

The first path is the copy `build-app.sh` generates with the team resolved; it is not a tracked
file. Its template is `build/entitlements.mac.plist.in`, and the `.in` suffix matters, because
electron-builder discovers `build/entitlements.mac.plist` by convention and hands it straight to
the signer. A template sitting at that exact path is picked up whether or not it has been
resolved. An unresolved `<TEAM_ID>` is not well-formed XML, and packaging fails with
`Opening and ending tag mismatch: "TEAM_ID" != "string"`; that only happens once a certificate
exists, because with none, signing is skipped and the file is never parsed. Keeping the template
off the discovered path is what stops a half-resolved file reaching codesign.

Both plists grant what Electron needs (`allow-jit`, `allow-unsigned-executable-memory`), and the
app plist also claims the App Group. Without that claim
`containerURL(forSecurityApplicationGroupIdentifier:)` returns nil, the app falls back to reaching
into `~/Library/Group Containers/` by path as a process entitled for nothing, and macOS asks the
user for access to other apps' data. A keychain access group answers differently: macOS kills a
bundle claiming one at exec unless the bundle also embeds a provisioning profile issued by Apple, so
nothing in either app shares a keychain item between the app and its extensions; see
[`sessions-and-security.md`'s Local cache files at rest](sessions-and-security.md#local-cache-files).

### App Group from the certificate

The Team ID is read from the signing certificate's `OU` field and substituted into
`<TEAM_ID>.group.com.alexhaslam.magimail` at build time. It comes from the certificate rather than
from configuration, because a team ID only means anything as the team of the certificate doing the
signing; one that disagrees with it produces entitlements macOS rejects. `APPLE_TEAM_ID` in the
environment is ignored, with a warning. Where no team is resolved the App Group entitlement is
dropped rather than left dangling, since an unauthorised group claim is refused outright. App Groups
need no provisioning profile, so a plain development certificate is enough and no Developer Program
enrolment is involved.

The substituted plist is generated under `build/.generated/` and is gitignored, so a run that dies
mid-build cannot leave a resolved team ID in the tracked plist.

## Ad-hoc builds

With no certificate at all, the build stops. An ad-hoc signature has no team, so every `.appex`
fails to load, not one in particular: for Magimail that is the Share Sheet entry, the widgets and
the Focus Filter, all three, together. Pass `--adhoc` to build one deliberately. It launches on this
Mac, which is useful for working on the Electron side without an Apple account, and the choice
carries down to every script the build shells out to.

An ad-hoc build gives up three things:

- **Extensions.** No `.appex` loads, so the Share Sheet, the widgets and the Focus Filter are absent.
- **Stable notification permission.** The Swift helper is not an extension and does run, but
  authorisation is tied to a signature that changes on every rebuild, so granted permissions are not
  kept.
- **The App Group.** No team means no group entitlement, so the app and the helper fall back to
  Application Support for `accounts.json` and `focus-filter.json`.

`--adhoc` also turns the app bundle's hardened runtime off, because an ad-hoc signature carries no
team and library validation otherwise rejects the Electron framework's own signature. The helper,
dylib, addon and extensions still sign themselves with `--options runtime`, so only the app bundle
and its framework are affected.

`mac.identity` is **not** set in `electron-builder.json`. The script passes the identity through
electron-builder's `CSC_NAME`, so swapping certificates is a one-variable change. Ad-hoc is the
exception: `--adhoc` passes `-c.mac.identity=-` and `-c.mac.hardenedRuntime=false` straight to
electron-builder, leaving the config untouched. An identity of `-` is ad-hoc signing, not skipping
it; disabling auto-discovery would leave the bundle unsigned, and Apple Silicon refuses to launch an
unsigned binary.

## Building with a Developer ID certificate

The code is already set up for this grade: a local build detects a
`Developer ID Application` certificate and uses it, `swift/build.sh` reads the team from it for the
App Group, and `electron-builder.json` turns on `mac.hardenedRuntime` and points `mac.entitlements`
and `mac.entitlementsInherit` at the team-resolved plists. What is left is your Apple account, the
certificate and the notarisation credential, and none of them is a code change.

1. **Join the Apple Developer Program and install the `Developer ID Application` certificate** in the
   login Keychain of the machine that builds. Make it on that machine, so the private key stays
   there: a `.cer` downloaded from developer.apple.com against a CSR made elsewhere installs without
   its key and will not sign anything.
2. **Store a notarisation credential** so `xcrun notarytool` can authenticate. The profile is stored
   once, in the same Keychain, with the App Store Connect API key as its input:

   ```bash
   xcrun notarytool store-credentials magic-apps-notary \
     --key ~/path/to/AuthKey_ABC1234567.p8 \
     --key-id ABC1234567 \
     --issuer 00000000-0000-0000-0000-000000000000
   ```

Notarisation is what makes a signed bundle open on a Mac that has never seen the certificate. A
bundle signed with the paid grade but never submitted opens only where the certificate is already
trusted, which is the machine that built it. Nothing exports a raw `.p12` to a third-party CI
runner: the certificate stays on the machine holding its private key.

## Packaging in CI

The packaging jobs go through this script, so a bundle missing the Swift helper, the native addon or
an extension fails the job instead of packaging with a warning and reporting success. `build.yml`
packages both apps' unpacked bundles on every push to `main` on GitHub-hosted macOS (`macos-latest`).
Because CI runners have no Apple certificates installed, `build.yml` passes `--adhoc` so the job
proves every native artefact compiles and assembles cleanly without requiring developer credentials.
The compile-only Swift check in `ci.yml` also runs on GitHub-hosted macOS. The workflows, their triggers
and what each step does are in [`../developer-guidelines/ci.md`](../developer-guidelines/ci.md).

### Compile-only extension check

`check-swift` in `ci.yml` runs each extension's own `build.sh` with `MAGIC_SUITE_COMPILE_ONLY=1`,
which stops the script once the `.appex` is assembled and before it stamps a bundle version and
signs. Stamping needs `node` and signing needs a certificate in an unlocked keychain, and neither
answers the only question a pull request is asking, which is whether the Swift still compiles. The
`.appex` left in `.build/release` is unsigned and must not be installed; `build-app.sh` rebuilds and
signs it before packaging. Running the real script rather than a bare `xcodebuild` keeps the two
compiles the same compile.
