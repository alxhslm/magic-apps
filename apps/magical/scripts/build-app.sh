#!/usr/bin/env bash
#
# Build Magical.app, and optionally install it.
#
# Builds the complete standalone bundle — Electron host, native toolbar dylib,
# native N-API addon, Swift helper, App Intents extension and WidgetKit
# extension — asserting all native artefacts exist before assembling the bundle.
#
# Usage:
#   ./scripts/build-app.sh                  # build the bundle into release/
#   ./scripts/build-app.sh --install        # ...and replace /Applications/Magical.app
#   ./scripts/build-app.sh --dist           # package the .dmg and updater .zip;
#                                           # this is the release path and needs
#                                           # a Developer ID certificate
#   ./scripts/build-app.sh --adhoc          # build without a certificate, knowing
#                                           # the extensions will not load
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
#   Override with --identity "<name>" or MAGICAL_SIGN_IDENTITY. See
#   docs/shared/building-and-signing.md for what changes on a paid account.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR" && git rev-parse --show-toplevel)"
INSTALL_PATH="/Applications/Magical.app"

# Shared with Magimail so both apps resolve a certificate identically.
. "$REPO_ROOT/tools/signing.sh"

DO_INSTALL=0
DIST=0
FORCE_ADHOC=0
IDENTITY="${MAGICAL_SIGN_IDENTITY:-}"

while [ $# -gt 0 ]; do
    case "$1" in
    --) ;;
    --install) DO_INSTALL=1 ;;
    --dist) DIST=1 ;;
    --adhoc) FORCE_ADHOC=1 ;;
    --identity)
        IDENTITY="${2:?--identity needs a certificate name}"
        shift
        ;;
    -h | --help)
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
# electron-builder.json makes swapping certificates a one-variable change rather
# than a config edit. Ad-hoc is the exception: it is passed as `mac.identity=-`
# on the command line.

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
    assert_release_identity "$IDENTITY" "Magical"
else
    assert_signing_identity "$IDENTITY" "Magical" "the Focus filter will not appear in System Settings and notification permissions will reset on every rebuild"
fi

# The team is read from the certificate, never configured.
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
    export MAGICAL_SIGN_IDENTITY="$IDENTITY"
    if [ -n "$TEAM_ID" ]; then
        export APPLE_TEAM_ID="$TEAM_ID"
        step "Signing as: $IDENTITY (Team ID: $TEAM_ID)"
    else
        step "Signing as: $IDENTITY"
    fi
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
fi

# Resolve <TEAM_ID> into a generated copy, never into the tracked plist.
#
# The template is build/entitlements.mac.plist.in, deliberately not
# build/entitlements.mac.plist: electron-builder discovers that exact path by
# convention and hands it to the signer, and an unresolved <TEAM_ID> there is
# not even well-formed XML. Keeping the template off the discovered path means
# a half-resolved file can never reach codesign.
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

step "Building Swift helper (release)"
# build.sh, not a bare `swift build`: the helper has to claim the app's own
# bundle identifier, which is what a packaged sidecar needs to be treated as
# part of the app rather than a stray executable.
#
# Release, not debug: electron-builder bundles .build/release, so a debug build
# leaves the packaged app with no settings window.
(cd "$APP_DIR/swift" && ./build.sh release)

step "Generating icon assets"
(cd "$REPO_ROOT" && swift apps/magical/build/generate-icons.swift)

step "Building native toolbar dylib (release)"
(cd "$APP_DIR/native" && swift build -c release)

step "Building native N-API addon"
(cd "$APP_DIR/native" && npx node-gyp rebuild)

step "Building App Intents extension (release)"
# Vends the macOS Focus filter. Must be a separate ExtensionKit bundle: the
# AppIntents runtime discovers intents from bundles it can enumerate, and
# neither the Electron executable nor MagicalHelper is one — they share
# Magical.app's identity but are not themselves bundles.
(cd "$APP_DIR/app-intents-extension" && ./build.sh release)

step "Building WidgetKit extension (release)"
# Release, not debug: electron-builder bundles .build/release, and an app
# installed without the .appex shows no widgets in the gallery at all.
(cd "$APP_DIR/widgets" && ./build.sh release)

step "Verifying bundle inputs"
# electron-builder downgrades a missing file to a warning and packages anyway,
# which is how Magimail once shipped a bundle with no toolbar.
REQUIRED=(
    "dist/main.js"
    "dist/calendar-preload.js"
    "build/icon.icns"
    "swift/.build/release/MagicalHelper"
    "swift/.build/release/HelperResources/en.lproj/Localizable.strings"
    "swift/.build/release/HelperResources/en-GB.lproj/Localizable.strings"
    "native/.build/release/libMagicalNative.dylib"
    "native/build/Release/magical_addon.node"
    "app-intents-extension/.build/release/MagicalAppIntents.appex"
    "app-intents-extension/Resources/Metadata.appintents"
    "widgets/.build/release/MagicalWidgets.appex"
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
    die "Missing bundle inputs (build/icon.icns comes from \`pnpm --filter magical icons\`)."
fi

step "Packaging Magical.app"
if [ "$DIST" = "1" ]; then
    # Every target in electron-builder.json, not just the unpacked directory:
    # the .dmg people download, the .zip electron-updater pulls, and the
    # .blockmap files that make an update a delta rather than a full download.
    (cd "$APP_DIR" && npx electron-builder --mac $IDENTITY_ARGS)
else
    (cd "$APP_DIR" && npx electron-builder --mac --dir $IDENTITY_ARGS)
fi

BUILT_APP="$(find "$APP_DIR/release" -maxdepth 2 -name 'Magical.app' -print -quit)"
[ -n "$BUILT_APP" ] || die "electron-builder produced no Magical.app"
echo "  Built: $BUILT_APP"

step "Verifying the packaged bundle"
# The preflight above proves the artefacts were built; this proves
# electron-builder put them in the bundle. It logs a copy it did not make and
# carries on, and the helper only takes Magical.app's identity from
# Contents/MacOS. These are the destinations electron-builder.json declares,
# written out so a wrong one is caught rather than followed.
BUNDLED=(
    "Contents/MacOS/MagicalHelper"
    "Contents/Resources/en.lproj/Localizable.strings"
    "Contents/Resources/en-GB.lproj/Localizable.strings"
    "Contents/Resources/libMagicalNative.dylib"
    "Contents/Resources/magical_addon.node"
    # The dylib reads this beside itself for the Dock tile artwork, so it has to land
    # in Contents/Resources and nowhere else.
    "Contents/Resources/icon.svg"
    # Where it lands decides whether it loads at all: electron-builder re-signs a
    # nested bundle with the host's inherited entitlements, which strips the
    # extension's sandbox, so electron-builder.json keeps it out of that pass by
    # path. A wrong destination there would silently stop being signIgnored.
    "Contents/Extensions/MagicalAppIntents.appex"
    "Contents/PlugIns/MagicalWidgets.appex"
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
    die "Magical.app is missing artefacts electron-builder.json says it bundles."
fi

# MARK: - Install

if [ "$DO_INSTALL" = "1" ]; then
    step "Installing to $INSTALL_PATH"

    if pgrep -f "$INSTALL_PATH/Contents/MacOS/Magical$" >/dev/null 2>&1; then
        echo "  Quitting the running Magical..."
        osascript -e 'tell application "Magical" to quit' >/dev/null 2>&1 || true
        for _ in $(seq 1 100); do
            pgrep -f "$INSTALL_PATH/Contents/MacOS/Magical$" >/dev/null 2>&1 || break
            sleep 0.2
        done
        pgrep -f "$INSTALL_PATH/Contents/MacOS/Magical$" >/dev/null 2>&1 &&
            die "Magical is still running — quit it and retry."
    fi

    if [ -d "$INSTALL_PATH" ]; then
        BACKUP="/tmp/Magical-rollback-$(date +%Y%m%d-%H%M%S).app"
        echo "  Keeping a rollback copy at $BACKUP"
        mv "$INSTALL_PATH" "$BACKUP"
    fi

    cp -R "$BUILT_APP" "$INSTALL_PATH"
    xattr -dr com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true

    echo "  Installed. User data in ~/Library/Application Support/Magical is untouched."
fi

step "Done"
