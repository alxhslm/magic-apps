#!/bin/bash
# Builds MagimailHelper, the Swift sidecar that owns the menu bar item, the
# settings window, notifications and widget reloads.
# Usage: ./build.sh [debug|release]
#
# The build is a plain `swift build`; the interesting part is the signing.
#
# The helper must claim the app's bundle id, not the identifier codesign derives
# from the filename, or macOS refuses to let it post notifications — silently,
# with nothing in the build output. Hence the explicit `--identifier`, and
# `Contents/MacOS/MagimailHelper` in `mac.signIgnore` so electron-builder does
# not sign it back to the default.
#
# See docs/shared/notifications.md#bundle-identity for why, and for the
# packaging destination that goes with it.
#
# The helper also carries the App Group entitlement, so it can read
# focus-filter.json out of the group container the App Intents extension writes
# to. Helper.entitlements.in holds it; the team comes from the certificate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel)"
. "$REPO_ROOT/tools/signing.sh"
. "$REPO_ROOT/tools/localization.sh"
CONFIG="${1:-release}"

# xcstringstool ships with a full Xcode, not the Command Line Tools.
ensure_xcode "MagimailHelper" || exit 1

echo "Building MagimailHelper ($CONFIG)..."
(cd "$SCRIPT_DIR" && swift build -c "$CONFIG")

BIN_DIR="$(cd "$SCRIPT_DIR" && swift build -c "$CONFIG" --show-bin-path)"
BIN="$BIN_DIR/MagimailHelper"
[ -f "$BIN" ] || {
    echo "swift build produced no MagimailHelper at $BIN" >&2
    exit 1
}

# The helper's strings resolve against `Bundle.main`, which for an executable at
# Contents/MacOS is the app bundle, so the compiled catalog has to land in
# Contents/Resources/en.lproj. SwiftPM copies a `.xcstrings` into a resource
# bundle uncompiled, so compile it here and let electron-builder carry the
# result into the app.
#
# Compiled after `swift build`, into the bin path it reports rather than the
# `.build/$CONFIG` symlink: on a clean tree that symlink does not exist yet, so
# writing through it creates a real directory that `swift build` then replaces,
# taking the catalog with it.
RESOURCES_DIR="$BIN_DIR/HelperResources"
rm -rf "$RESOURCES_DIR"
mkdir -p "$RESOURCES_DIR"
compile_string_catalog "$SCRIPT_DIR/Resources/Localizable.xcstrings" "$RESOURCES_DIR"

# The identity the helper must claim, taken from the app it ships inside rather
# than repeated here, so the two cannot drift apart.
APP_ID="$(node -p "require('$SCRIPT_DIR/../electron-builder.json').appId")"

# Resolved the same way as the app itself, so the helper and its container
# never end up signed by different teams. The variable is validated rather
# than trusted: naming a certificate that is not installed used to fail here
# with "no identity found", long after the name was chosen.
IDENTITY="$(resolve_signing_identity "${MAGIMAIL_SIGN_IDENTITY:-}")"
assert_signing_identity "$IDENTITY" "the Magimail helper" "notification permissions will reset on every rebuild"

# The helper reads focus-filter.json out of the App Group container. The team
# comes from the certificate, the same as the app and its extensions, so the
# group it claims is one its signature can actually back.
TEAM_ID="$(resolve_team_id "$IDENTITY")"
ENTITLEMENTS="$SCRIPT_DIR/.build/generated/helper.entitlements.plist"
prepare_entitlements "$SCRIPT_DIR/Helper.entitlements.in" "$ENTITLEMENTS" "$TEAM_ID"

if [ -n "$TEAM_ID" ]; then
    sign_hardened "$IDENTITY" "$BIN" --identifier "$APP_ID" --entitlements "$ENTITLEMENTS"
else
    sign_hardened "$IDENTITY" "$BIN" --identifier "$APP_ID"
fi

echo "Built $BIN (signed with: $IDENTITY, identifier: $APP_ID)"
