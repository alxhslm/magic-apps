#!/usr/bin/env bash
set -euo pipefail

# Semi-automated screenshot generation for Magic Apps website and documentation.
# Renders native SwiftUI views (widgets, popovers, focus filter panes) using
# invented fixtures, converts them to WebP, and cleans up temporary PNGs. Also
# renders the SF Symbols the help pages name, as PNG alpha masks.
#
# Usage:
#   ./tools/generate-shots.sh [target_dir]
#
# Defaults to website/src/assets if no directory is specified.

TARGET_DIR="${1:-website/src/assets}"
mkdir -p "$TARGET_DIR"

echo "🎨 Rendering native macOS SwiftUI views with tools/shots..."
swift run --package-path tools/shots shots "$TARGET_DIR"

# The SF Symbols the help pages name, as alpha masks the stylesheet tints.
mkdir -p "$TARGET_DIR/sym"
swift run --package-path tools/shots symbols "$TARGET_DIR/sym"

echo "📦 Converting generated PNGs to WebP..."
SHOTS=(
  "shot-widgets-magical"
  "shot-popover-magical"
  "shot-invitations-magical"
  "shot-focus-magical"
  "shot-tasks-magical"
  "shot-widgets"
  "shot-popover"
  "shot-focus"
)

for shot in "${SHOTS[@]}"; do
  png_path="$TARGET_DIR/$shot.png"
  webp_path="$TARGET_DIR/$shot.webp"
  if [[ -f "$png_path" ]]; then
    if command -v cwebp >/dev/null 2>&1; then
      cwebp -q 88 "$png_path" -o "$webp_path" >/dev/null 2>&1
      rm "$png_path"
      echo "  ✓ Generated $shot.webp"
    else
      echo "  ⚠️ cwebp not found in PATH; keeping $shot.png"
    fi
  fi
done

echo "✨ Screenshot generation complete: $TARGET_DIR"
