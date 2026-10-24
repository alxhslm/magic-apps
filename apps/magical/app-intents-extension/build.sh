#!/bin/bash
# Builds the MagicalAppIntents.appex bundle from Swift sources.
# Usage: ./build.sh [debug|release]
# Set MAGIC_SUITE_COMPILE_ONLY=1 to stop after the compile, as CI does.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel)"
. "$REPO_ROOT/tools/signing.sh"
. "$REPO_ROOT/tools/localization.sh"
CONFIG="${1:-debug}"

PRODUCT_NAME="MagicalAppIntents"
APPEX_DIR="$SCRIPT_DIR/.build/$CONFIG/$PRODUCT_NAME.appex"
CONTENTS_DIR="$APPEX_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"

# compile_string_catalog needs xcstringstool, which ships only with a full
# Xcode, not the Command Line Tools. The Swift half of this build is otherwise
# swiftc's.
ensure_xcode "$PRODUCT_NAME" || exit 1

# Clean previous build
rm -rf "$APPEX_DIR"
mkdir -p "$MACOS_DIR"
mkdir -p "$RESOURCES_DIR"

SWIFT_OPT=""
if [ "$CONFIG" = "release" ]; then
    SWIFT_OPT="-O"
fi

# Compile Swift source into a Mach-O executable
# Entry point: an .appex is launched by the system, not run as a normal
# program. Xcode links extension targets with `-e _NSExtensionMain` so the
# process hands control to Foundation's extension host loop. Without it swiftc
# emits its own `_main`, which returns immediately, the process exits 0 before
# the host connects, and the Focus UI reports "Could not load Focus Filter".
#
# `-parse-as-library` is what lets a file named main.swift carry `@main`; an
# editor that does not know about the flag reports that pairing as an error.
swiftc \
    $SWIFT_OPT \
    -Xlinker -e -Xlinker _NSExtensionMain \
    -module-name "$PRODUCT_NAME" \
    -target "arm64-apple-macosx14.0" \
    -framework Foundation \
    -framework AppIntents \
    -framework ExtensionFoundation \
    -parse-as-library \
    -o "$MACOS_DIR/$PRODUCT_NAME" \
    "$SCRIPT_DIR/Sources/main.swift" \
    "$SCRIPT_DIR/Sources/CalendarDot.swift" \
    "$SCRIPT_DIR/../swift/Sources/MagicalHelperLib/SecretFile.swift"

# Copy Info.plist
cp "$SCRIPT_DIR/Info.plist" "$CONTENTS_DIR/Info.plist"

# Copy Metadata.appintents
#
# Hand-written rather than generated: the AppIntents metadata is normally
# produced by Xcode's appintentsmetadataprocessor, which needs an Xcode target.
# The mangled type names in it are what the runtime resolves the intent through,
# so renaming a type or the module means regenerating them — check one with
# `xcrun swift-demangle '$s17MagicalAppIntents0A11FocusFilterV'`.
cp -R "$SCRIPT_DIR/Resources/Metadata.appintents" "$RESOURCES_DIR/Metadata.appintents"

# Compile the String Catalog into the .strings/.stringsdict the bundle reads at
# runtime. swiftc has no equivalent step; see tools/localization.sh.
compile_string_catalog \
    "$SCRIPT_DIR/Resources/Localizable.xcstrings" \
    "$RESOURCES_DIR"

if compile_only; then
    echo "Compiled $PRODUCT_NAME; not stamped or signed."
    exit 0
fi

# Stamp the app's version onto the extension, matching the helper.
APP_VERSION="$(node -p "require('$SCRIPT_DIR/../package.json').version")"
stamp_bundle_version "$CONTENTS_DIR/Info.plist" "$APP_VERSION"

# Resolve a signing identity. An App Intents extension is only registered by
# the system when it and its containing app are signed by the same team, so
# ad-hoc (`--sign -`) is not sufficient.
IDENTITY="$(resolve_signing_identity "${MAGICAL_SIGN_IDENTITY:-}")"
assert_signing_identity "$IDENTITY" "the App Intents extension" "the Focus Filter will not appear in System Settings"

# The team is read from the certificate, never configured: a team ID that
# disagrees with the signing certificate yields a signature macOS rejects, and a
# hardcoded one gives anyone building on their own Apple ID an extension whose
# log never reaches the app.
TEAM_ID="$(resolve_team_id "$IDENTITY")"

ENTITLEMENTS_FILE="$SCRIPT_DIR/.build/$CONFIG/Entitlements.plist"
if [ -n "$TEAM_ID" ]; then
    APP_ID="$(node -p "require('$SCRIPT_DIR/../electron-builder.json').appId")"
    plutil -replace AppGroupIdentifier -string "${TEAM_ID}.group.${APP_ID}" \
        "$CONTENTS_DIR/Info.plist"
fi
prepare_entitlements "$SCRIPT_DIR/Entitlements.plist" "$ENTITLEMENTS_FILE" "$TEAM_ID"

sign_hardened "$IDENTITY" "$APPEX_DIR" \
    --entitlements "$ENTITLEMENTS_FILE"

echo "Built $APPEX_DIR (signed with: $IDENTITY)"
