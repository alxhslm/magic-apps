#!/bin/bash
# Builds MagimailWidgets.appex, the WidgetKit extension, using Xcode's app-extension target.
# Usage: ./build.sh [debug|release]
# Set MAGIC_SUITE_COMPILE_ONLY=1 to stop after the compile, as CI does.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel)"
. "$REPO_ROOT/tools/signing.sh"
CONFIG="${1:-release}"

XCODE_CONF="Release"
if [ "$CONFIG" = "debug" ]; then
    XCODE_CONF="Debug"
fi

PRODUCT_NAME="MagimailWidgets"
DERIVED_DATA="$SCRIPT_DIR/.build/DerivedData"
TARGET_BUILD_DIR="$DERIVED_DATA/Build/Products/$XCODE_CONF"
OUTPUT_DIR="$SCRIPT_DIR/.build/$CONFIG"

# xcodebuild ships only with a full Xcode, and xcode-select may be pointing at
# the Command Line Tools, which has none. ensure_xcode honours xcode-select
# before falling back to the default install path, so an Xcode kept anywhere
# else still builds.
ensure_xcode "$PRODUCT_NAME" || exit 1

echo "Building $PRODUCT_NAME via xcodebuild ($XCODE_CONF)..."
xcrun xcodebuild \
    -project "$SCRIPT_DIR/MagimailWidgets.xcodeproj" \
    -scheme "$PRODUCT_NAME" \
    -configuration "$XCODE_CONF" \
    -derivedDataPath "$DERIVED_DATA" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY=""

mkdir -p "$OUTPUT_DIR"
rm -rf "$OUTPUT_DIR/$PRODUCT_NAME.appex"
cp -R "$TARGET_BUILD_DIR/$PRODUCT_NAME.appex" "$OUTPUT_DIR/$PRODUCT_NAME.appex"

if compile_only; then
    echo "Compiled $PRODUCT_NAME; not stamped or signed."
    exit 0
fi

# Stamp the app's version onto the extension. chronod keys its cached widget
# descriptors on the extension version, so a widget left behind at its own
# version would keep serving stale descriptors after the app is updated.
# Must happen before codesign, or it would break the signature.
APP_VERSION="$(node -p "require('$SCRIPT_DIR/../package.json').version")"
stamp_bundle_version "$OUTPUT_DIR/$PRODUCT_NAME.appex/Contents/Info.plist" "$APP_VERSION"

# Resolve the identity the same way the app itself does, so the extension and its
# container are always signed by the same team. MAGIMAIL_SIGN_IDENTITY is how
# build-app.sh hands its choice down; it is validated rather than trusted, so a
# stale value warns and falls back instead of failing later inside codesign.
IDENTITY="$(resolve_signing_identity "${MAGIMAIL_SIGN_IDENTITY:-}")"
assert_signing_identity "$IDENTITY" "the Widget extension" "the widgets will not appear in the gallery"

# The team is read from the certificate, never configured: a team ID that
# disagrees with the signing certificate yields a signature macOS rejects, and a
# hardcoded one gives anyone building on their own Apple ID a dead widget.
TEAM_ID="$(resolve_team_id "$IDENTITY")"

ENTITLEMENTS_FILE="$OUTPUT_DIR/entitlements.plist"
if [ -n "$TEAM_ID" ]; then
    APP_ID="$(node -p "require('$SCRIPT_DIR/../electron-builder.json').appId")"
    plutil -replace AppGroupIdentifier -string "${TEAM_ID}.group.${APP_ID}" \
        "$OUTPUT_DIR/$PRODUCT_NAME.appex/Contents/Info.plist"
fi
prepare_entitlements "$SCRIPT_DIR/entitlements.plist" "$ENTITLEMENTS_FILE" "$TEAM_ID"

sign_hardened "$IDENTITY" "$OUTPUT_DIR/$PRODUCT_NAME.appex" \
    --entitlements "$ENTITLEMENTS_FILE"

echo "Built $OUTPUT_DIR/$PRODUCT_NAME.appex (signed with: $IDENTITY)"
