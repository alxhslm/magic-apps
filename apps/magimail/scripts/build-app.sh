#!/usr/bin/env bash
#
# Build the complete Magimail.app bundle, and optionally install it.
#
# Magimail is four build systems in a trench coat — tsup for the Electron main
# process, SwiftPM for the helper and the toolbar dylib, node-gyp for the N-API
# addon, and xcodebuild for the Share and Widget extensions — and
# electron-builder only *warns* when the native artefacts it is told to bundle
# are missing. A bundle built without them launches with no toolbar, no tray, no
# settings window, no notifications and no widgets, which is easy to miss. This
# script builds all six and then refuses to package unless every artefact is
# actually on disk.
#
# Usage:
#   ./scripts/build-app.sh                  # build the bundle into release/
#   ./scripts/build-app.sh --install        # ...and replace /Applications/Magimail.app
#   ./scripts/build-app.sh --install --fast # skip the native rebuilds (JS-only changes)
#   ./scripts/build-app.sh --dist           # package the .dmg and updater .zip;
#                                           # this is the release path and needs
#                                           # a Developer ID certificate
#   ./scripts/build-app.sh --adhoc          # build without a certificate, knowing
#                                           # the extensions will not load
#
# Packaging costs ~2.5 minutes even with --fast, because electron-builder
# re-extracts the Electron runtime every run. For iterating on TypeScript use
# `pnpm dev` instead; this script is for verifying the real bundle.
#
# Signing:
#   A local build takes the best certificate in your keychain: Developer ID,
#   then Apple Distribution, then Apple Development, then Mac Developer. With
#   none of them it stops rather than producing a bundle whose helper and
#   extensions macOS will silently refuse to load. --adhoc builds one anyway,
#   for working on the Electron side without an Apple account.
#
#   --dist is different. A release opens on a Mac that has never seen the
#   certificate, so it is signed with Developer ID Application and nothing
#   else: an Apple Development signature is refused there, and since Sequoia
#   there is no right-click bypass left. Without that certificate --dist fails
#   loudly rather than falling back.
#
#   Override with --identity "<name>" or MAGIMAIL_SIGN_IDENTITY. See
#   docs/shared/building-and-signing.md for what changes when you move from a
#   free account to a paid one.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR" && git rev-parse --show-toplevel)"
INSTALL_PATH="/Applications/Magimail.app"

# Certificate resolution is shared with the extension build scripts, so that
# they cannot disagree about which certificate to use. They used to: this
# script preferred a Developer ID certificate while the extensions only ever
# looked for an Apple Development one, so on a machine carrying both, the app
# and its extensions were signed by different teams and macOS quietly declined
# to load the extensions.
. "$REPO_ROOT/tools/signing.sh"

DO_INSTALL=0
FAST=0
DIST=0
FORCE_ADHOC=0
IDENTITY="${MAGIMAIL_SIGN_IDENTITY:-}"

while [ $# -gt 0 ]; do
    case "$1" in
    --install) DO_INSTALL=1 ;;
    --fast) FAST=1 ;;
    --dist) DIST=1 ;;
    --adhoc) FORCE_ADHOC=1 ;;
    --identity)
        IDENTITY="${2:?--identity needs a certificate name}"
        shift
        ;;
    -h | --help)
        # The header comment, minus the shebang, up to the first line of code.
        sed -n '3,/^[^#]/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
        exit 0
        ;;
    *)
        echo "Unknown option: $1 (try --help)" >&2
        exit 2
        ;;
    esac
    shift
done

step() { printf '\n\033[1;34m▸ %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$1" >&2; }
die() {
    printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2
    exit 1
}

# MARK: - Signing identity
#
# electron-builder takes the identity from CSC_NAME. Keeping it out of
# electron-builder.json is what makes swapping certificates a one-variable
# change rather than a config edit. Ad-hoc is the exception: it is passed as
# `mac.identity=-` on the command line, below.

IDENTITY_ARGS=""
if [ "$FORCE_ADHOC" = "1" ]; then
    IDENTITY="-"
    # Inherited by the helper and extension scripts this shells out to, so one
    # --adhoc covers the whole build rather than each script deciding again.
    export MAGIC_SUITE_ALLOW_ADHOC=1
elif [ "$DIST" = "1" ]; then
    # --dist is the release path, which tools/release.sh drives. It is signed
    # with Developer ID and nothing else: the fallback chain below ends at
    # Apple Development, which produces a bundle that opens on this Mac and
    # nowhere else. See docs/shared/building-and-signing.md.
    IDENTITY="$(resolve_release_identity "$IDENTITY")"
else
    IDENTITY="$(resolve_signing_identity "$IDENTITY")"
fi

if [ "$DIST" = "1" ]; then
    assert_release_identity "$IDENTITY" "Magimail"
else
    assert_signing_identity "$IDENTITY" "Magimail" "no .appex will load: no Share Sheet entry, no widgets and no Focus Filter"
fi

# The team is read from the certificate, never configured. A team ID is only
# meaningful as the team of the certificate doing the signing: one that
# disagrees with it produces entitlements macOS rejects, and one supplied
# without any certificate at all describes a signature that was never made.
TEAM_ID="$(resolve_team_id "$IDENTITY")"
if [ -n "${APPLE_TEAM_ID:-}" ] && [ "${APPLE_TEAM_ID}" != "${TEAM_ID}" ]; then
    warn "Ignoring APPLE_TEAM_ID=$APPLE_TEAM_ID; the team is taken from the signing certificate."
fi

if [ "$IDENTITY" != "-" ]; then
    # electron-builder requires stripping the type prefix from CSC_NAME;
    # it selects the appropriate certificate from the keychain automatically.
    CSC_NAME="$IDENTITY"
    CSC_NAME="${CSC_NAME#Developer ID Application: }"
    CSC_NAME="${CSC_NAME#Apple Distribution: }"
    CSC_NAME="${CSC_NAME#Apple Development: }"
    CSC_NAME="${CSC_NAME#Mac Developer: }"
    export CSC_NAME
    unset CSC_IDENTITY_AUTO_DISCOVERY
    # The Share and App Intents extensions are signed by their own build
    # scripts, not by electron-builder, and both read this. The App Intents
    # extension in particular is only registered by the system when it and the
    # containing app carry the same team, so they must not diverge.
    export MAGIMAIL_SIGN_IDENTITY="$IDENTITY"
    if [ -n "$TEAM_ID" ]; then
        export APPLE_TEAM_ID="$TEAM_ID"
        step "Signing as: $IDENTITY (Team ID: $TEAM_ID)"
    else
        step "Signing as: $IDENTITY"
    fi
    case "$IDENTITY" in
    "Developer ID Application:"*)
        echo "  Distribution certificate: opens on other Macs once notarised."
        ;;
    "Apple Development:"*)
        echo "  Development certificate: fine for this Mac. The bundle will not open"
        echo "  on other Macs without Developer ID + notarisation (see docs/shared/building-and-signing.md)."
        ;;
    esac
else
    # Ad-hoc signing is opt-in through electron-builder's `mac.identity`, which
    # must be exactly "-". It is not the same as skipping signing: electron-builder
    # rewrites the Electron binary, and Apple Silicon kills an unsigned bundle at
    # launch. Passing it on the command line keeps identity out of the config, so
    # swapping certificates stays a one-variable change. Hardened runtime is off
    # for the same reason: ad-hoc has no team, so library validation rejects the
    # Electron framework's own signature.
    unset CSC_IDENTITY_AUTO_DISCOVERY
    IDENTITY_ARGS="-c.mac.identity=- -c.mac.hardenedRuntime=false"
    warn "No signing certificate — the bundle will be ad-hoc signed."
    warn "macOS may reset notification and login-item permissions on each rebuild."
fi

# Resolve <TEAM_ID> into a generated copy, never into the tracked plist.
#
# Substituting in place and restoring on an EXIT trap leaves a hardcoded team ID
# sitting in a tracked file on any run that dies before the trap fires — which is
# precisely the hardcoding the placeholder exists to remove, and it is one
# `git commit -a` away from being published.
#
# The template is build/entitlements.mac.plist.in, deliberately not
# build/entitlements.mac.plist: electron-builder discovers that exact path by
# convention and hands it to the signer. An unresolved <TEAM_ID> there is not
# even well-formed XML, so the moment a certificate exists and signing actually
# happens, packaging dies on "Opening and ending tag mismatch". Keeping the
# template off the discovered path means a half-resolved file can never reach
# codesign.
#
# Pointing mac.entitlements at the generated copy is part of the move to
# Developer ID in docs/shared/building-and-signing.md.
if [ -f "$APP_DIR/build/entitlements.mac.plist.in" ]; then
    prepare_entitlements \
        "$APP_DIR/build/entitlements.mac.plist.in" \
        "$APP_DIR/build/.generated/entitlements.mac.plist" \
        "$TEAM_ID"
fi

# MARK: - Build

step "Building @magimail/core"
(cd "$REPO_ROOT" && pnpm --filter @magimail/core build)

step "Building Electron main process"
(cd "$APP_DIR" && pnpm build)

# tsup replaces __BUILD_TIMESTAMP__ with the compile time. If the identifier
# survives into the bundle the define never ran, and the expiry check would
# fail closed on every launch of a shipped build. Catch that here, not at a
# tester's first run.
if grep -q '__BUILD_TIMESTAMP__' "$APP_DIR/dist/main.js"; then
    die "dist/main.js still contains __BUILD_TIMESTAMP__: the build timestamp was not injected."
fi

if [ "$FAST" = "1" ]; then
    warn "--fast: reusing existing Swift helper, toolbar addon and Share/Widget extensions."
else
    step "Building Swift helper (release)"
    # build.sh, not a bare `swift build`: the helper has to be signed as the app
    # itself (--identifier), or macOS refuses to let it post notifications.
    (cd "$APP_DIR/swift" && ./build.sh release)

    step "Building native toolbar dylib (release)"
    # Release, not debug: electron-builder bundles .build/release/, so a debug
    # build leaves the packaged app with no toolbar.
    (cd "$APP_DIR/native" && swift build -c release)

    step "Building native N-API addon"
    (cd "$APP_DIR/native" && npx node-gyp rebuild)

    step "Building Share extension (release)"
    (cd "$APP_DIR/share-extension" && ./build.sh release)

    # Signed with the same identity as the app: macOS refuses to load an
    # extension whose team differs from its container, so the widget would be
    # missing from the gallery rather than failing loudly.
    step "Building Widget extension (release)"
    (cd "$APP_DIR/widgets" && ./build.sh release)

    step "Building App Intents extension (release)"
    # Vends the macOS Focus Filter. Must be a separate ExtensionKit bundle: the
    # AppIntents runtime discovers intents from bundles it can enumerate, and
    # neither the Electron executable nor MagimailHelper is one — they share
    # Magimail.app's identity but are not themselves bundles.
    (cd "$APP_DIR/app-intents-extension" && ./build.sh release)
fi

# MARK: - Preflight
#
# electron-builder logs "file source doesn't exist" for a missing extraResource
# and packages anyway. Assert here so a half-built bundle can never ship.

step "Verifying native artefacts"
# The helper is checked here like any other artefact, but where it lands
# matters as much as that it exists: electron-builder puts it in Contents/MacOS
# (see electron-builder.json), which is what gives it Magimail.app's bundle
# identity. Notifications and widget reloads need it — see
# docs/shared/notifications.md#bundle-identity.
REQUIRED=(
    "swift/.build/release/MagimailHelper"
    "swift/.build/release/HelperResources/en.lproj/Localizable.strings"
    "swift/.build/release/HelperResources/en-GB.lproj/Localizable.strings"
    "native/.build/release/libMagimailNative.dylib"
    "native/build/Release/magimail_addon.node"
    "share-extension/.build/release/MagimailShare.appex"
    "widgets/.build/release/MagimailWidgets.appex"
    "app-intents-extension/.build/release/MagimailAppIntents.appex"
    "app-intents-extension/Resources/Metadata.appintents"
)
missing=0
for rel in "${REQUIRED[@]}"; do
    if [ -e "$APP_DIR/$rel" ]; then
        echo "  ✓ $rel"
    else
        echo "  ✗ $rel" >&2
        missing=1
    fi
done
if [ "$missing" = "1" ]; then
    die "Missing native artefacts (drop --fast to rebuild them)."
fi

step "Packaging Magimail.app"
if [ "$DIST" = "1" ]; then
    # Every target in electron-builder.json, not just the unpacked directory:
    # the .dmg people download, the .zip electron-updater pulls, and the
    # .blockmap files that make an update a delta rather than a full 150 MB.
    (cd "$APP_DIR" && npx electron-builder --mac $IDENTITY_ARGS)
else
    (cd "$APP_DIR" && npx electron-builder --mac --dir $IDENTITY_ARGS)
fi

BUILT_APP="$(find "$APP_DIR/release" -maxdepth 2 -name 'Magimail.app' -print -quit)"
[ -n "$BUILT_APP" ] || die "electron-builder produced no Magimail.app"
echo "  Built: $BUILT_APP"

step "Verifying the packaged bundle"
# The preflight above proves the artefacts were built; this proves
# electron-builder put them in the bundle. It logs a copy it did not make and
# carries on, and where a file lands decides whether macOS honours it at all:
# the helper takes Magimail.app's identity from Contents/MacOS, and an .appex
# outside Contents/PlugIns goes missing from the gallery rather than failing
# loudly. These are the destinations electron-builder.json declares, written out
# so a wrong one is caught rather than followed.
BUNDLED=(
    "Contents/MacOS/MagimailHelper"
    "Contents/Resources/en.lproj/Localizable.strings"
    "Contents/Resources/en-GB.lproj/Localizable.strings"
    "Contents/Resources/libMagimailNative.dylib"
    "Contents/Resources/magimail_addon.node"
    "Contents/PlugIns/MagimailShare.appex"
    "Contents/PlugIns/MagimailWidgets.appex"
    "Contents/Extensions/MagimailAppIntents.appex"
)
missing=0
for rel in "${BUNDLED[@]}"; do
    if [ -e "$BUILT_APP/$rel" ]; then
        echo "  ✓ $rel"
    else
        echo "  ✗ $rel" >&2
        missing=1
    fi
done
if [ "$missing" = "1" ]; then
    die "Magimail.app is missing artefacts electron-builder.json says it bundles."
fi

# MARK: - Install

if [ "$DO_INSTALL" = "1" ]; then
    step "Installing to $INSTALL_PATH"

    # Anchored with $: MagimailHelper lives in Contents/MacOS too, and an
    # unanchored pattern matches it as a prefix, reporting the app as still
    # running and refusing a perfectly good install.
    if pgrep -f "$INSTALL_PATH/Contents/MacOS/Magimail$" >/dev/null 2>&1; then
        echo "  Quitting the running Magimail..."
        osascript -e 'tell application "Magimail" to quit' >/dev/null 2>&1 || true
        for _ in $(seq 1 100); do
            pgrep -f "$INSTALL_PATH/Contents/MacOS/Magimail$" >/dev/null 2>&1 || break
            sleep 0.2
        done
        pgrep -f "$INSTALL_PATH/Contents/MacOS/Magimail$" >/dev/null 2>&1 &&
            die "Magimail is still running — quit it and retry."
    fi

    if [ -d "$INSTALL_PATH" ]; then
        BACKUP="/tmp/Magimail-rollback-$(date +%Y%m%d-%H%M%S).app"
        echo "  Keeping a rollback copy at $BACKUP"
        mv "$INSTALL_PATH" "$BACKUP"
    fi

    cp -R "$BUILT_APP" "$INSTALL_PATH"
    # Locally built bundles are not quarantined, but a stray attribute inherited
    # from an unzipped dependency would still make Gatekeeper refuse to launch.
    xattr -dr com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true

    echo "  Installed. User data in ~/Library/Application Support/Magimail is untouched."
    codesign -dv "$INSTALL_PATH" 2>&1 |
        grep -E '^(Authority|Identifier|TeamIdentifier|Signature)' |
        sed 's/^/  /' || true
fi

step "Done"
