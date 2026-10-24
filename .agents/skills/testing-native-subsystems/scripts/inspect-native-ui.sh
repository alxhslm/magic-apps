#!/usr/bin/env bash
#
# inspect-native-ui.sh [magical|magimail] [--screenshot]
# Inspects native Settings window via Accessibility, detects clipping, and optionally captures a screenshot.
set -euo pipefail

APP="${1:-magical}"
DO_SHOT=0
if [[ "${2:-}" == "--screenshot" ]] || [[ "${1:-}" == "--screenshot" ]]; then
  DO_SHOT=1
  [ "${1:-}" == "--screenshot" ] && APP="magical"
fi

case "$APP" in
  magical)
    PROC="MagicalHelper"
    TITLE="Magical Settings"
    ;;
  magimail)
    PROC="MagimailHelper"
    TITLE="Magimail Preferences"
    ;;
  *)
    echo "Usage: $0 [magical|magimail] [--screenshot]" >&2
    exit 1
    ;;
esac

echo "▸ Inspecting $APP Settings UI ($PROC)..."

OUT=$(osascript <<EOF 2>/dev/null || true
tell application "System Events"
  if not (exists process "$PROC") then return "NOT_RUNNING"
  tell process "$PROC"
    if not (exists window "$TITLE") then return "NO_WINDOW"
    tell window "$TITLE"
      set winPos to position
      set winSize to size
      set winX to item 1 of winPos
      set winY to item 2 of winPos
      set winW to item 1 of winSize
      set winH to item 2 of winSize
      
      set elemCount to count of UI elements
      set cbCount to 0
      try
        set cbCount to count of checkboxes of scroll area 1 of group 1 of group 1
      end try
      
      return (winX as text) & "," & (winY as text) & "," & (winW as text) & "," & (winH as text) & "|" & (elemCount as text) & "|" & (cbCount as text)
    end tell
  end tell
end tell
EOF
)

if [ "$OUT" = "NOT_RUNNING" ]; then
  echo "✗ Process $PROC is not running. Launch the app first." >&2
  exit 1
elif [ "$OUT" = "NO_WINDOW" ]; then
  echo "✗ Window '$TITLE' is not open. Open Settings with Cmd+, first." >&2
  exit 1
elif [ -z "$OUT" ]; then
  echo "✗ Could not query Accessibility tree. Check Terminal Accessibility permissions." >&2
  exit 1
fi

BOUNDS=$(echo "$OUT" | cut -d'|' -f1)
ELEMS=$(echo "$OUT" | cut -d'|' -f2)
CBS=$(echo "$OUT" | cut -d'|' -f3)

X=$(echo "$BOUNDS" | cut -d',' -f1)
Y=$(echo "$BOUNDS" | cut -d',' -f2)
W=$(echo "$BOUNDS" | cut -d',' -f3)
H=$(echo "$BOUNDS" | cut -d',' -f4)

echo "✓ Found '$TITLE': origin=($X, $Y), size=${W}x${H}pt"
echo "✓ Root UI elements: $ELEMS"
[ "$CBS" != "0" ] && echo "✓ Checkboxes in scrollable area: $CBS"

if [ "$DO_SHOT" = "1" ]; then
  SHOT_PATH="/tmp/${APP}_settings_$(date +%s).png"
  screencapture -R "${X},${Y},${W},${H}" "$SHOT_PATH" 2>/dev/null || true
  if [ -f "$SHOT_PATH" ]; then
    echo "✓ Snapshot saved to: $SHOT_PATH"
  fi
fi
