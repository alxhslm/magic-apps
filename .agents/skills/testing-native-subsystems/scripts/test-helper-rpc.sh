#!/usr/bin/env bash
#
# test-helper-rpc.sh [magical|magimail]
# Tests standalone Swift helper execution and stdio JSON-RPC.
set -euo pipefail

APP="${1:-magical}"

case "$APP" in
  magical)
    BIN_PATHS=(
      "/Applications/Magical.app/Contents/MacOS/MagicalHelper"
      "apps/magical/swift/.build/release/MagicalHelper"
      "apps/magical/swift/.build/arm64-apple-macosx/release/MagicalHelper"
    )
    QUERY='{"id":1,"method":"defaults.query","params":{}}'
    ;;
  magimail)
    BIN_PATHS=(
      "/Applications/Magimail.app/Contents/MacOS/MagimailHelper"
      "apps/magimail/swift/.build/release/MagimailHelper"
      "apps/magimail/swift/.build/arm64-apple-macosx/release/MagimailHelper"
    )
    QUERY='{"id":1,"method":"settings.show","params":{"pane":"notifications","settings":{}}}'
    ;;
  *)
    echo "Usage: $0 [magical|magimail]" >&2
    exit 1
    ;;
esac

BIN=""
for p in "${BIN_PATHS[@]}"; do
  if [ -x "$p" ]; then
    BIN="$p"
    break
  fi
done

[ -n "$BIN" ] || { echo "✗ $APP helper binary not found. Build or install the app first." >&2; exit 1; }

echo "▸ Testing $APP helper ($BIN)..."
RESPONSE=$(echo "$QUERY" | "$BIN" 2>&1)

if echo "$RESPONSE" | grep -q '"id":1'; then
  echo "✓ Helper responded cleanly over stdio JSON-RPC."
  echo "$RESPONSE" | grep '^{'
else
  echo "✗ Helper failed to respond as expected:"
  echo "$RESPONSE"
  exit 1
fi
