# Packaging

Never assemble an app bundle with bare `electron-builder`. It downgrades a missing native artefact to
a warning, so the bundle packages happily and then launches with no toolbar, no widgets and no
notifications. Use the packaging scripts:

```bash
# Build all native subsystems and package the DMG (asserts all six artefacts exist)
pnpm run magimail

# Build, package and replace /Applications/Magimail.app for local testing
pnpm run magimail:install
```

Packaging needs a local Apple codesigning certificate in your Keychain; for a bundle you install and
test on this Mac a free `Apple Development` certificate is enough. Pass `--adhoc` instead to build a
partial, ad-hoc-signed bundle that launches locally (its extensions will not load). The DMG lands in
`apps/magimail/release/Magimail-<version>-<arch>.dmg`.

A DMG you intend to hand to anyone else needs a `Developer ID Application` certificate and a
notarisation credential: `--dist` fails without them rather than producing a bundle no other Mac will
open.

See [`../shared/building-and-signing.md`](../shared/building-and-signing.md) for the signing grades
and what each artefact needs, and
[Building with a Developer ID certificate](../shared/building-and-signing.md#building-with-a-developer-id-certificate)
for the paid account.
