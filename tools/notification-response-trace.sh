#!/bin/bash
#
# Captures what macOS does with a notification response.
#
# main.log only says whether the helper saw the response. This reads the system
# notification daemon's own log, which says whether macOS received the click or button
# press and which process it tried to hand it to. Run it, click the banner, and read the
# result. No app rebuild is needed.
#
# Usage:
#   tools/notification-response-trace.sh [bundle-id]
#   tools/notification-response-trace.sh --past [bundle-id] [duration]
#
# The bundle id defaults to Magimail. `--past` reads the last 30 minutes instead of
# waiting for the next click.

set -euo pipefail

MODE="live"
if [ "${1:-}" = "--past" ]; then
  MODE="past"
  shift
fi

BUNDLE_ID="${1:-com.alexhaslam.magimail}"
PAST_DURATION="${2:-30m}"

case "$BUNDLE_ID" in
  com.alexhaslam.magimail)
    APP_NAME="Magimail"
    HELPER_NAME="MagimailHelper"
    ;;
  com.alexhaslam.magical)
    APP_NAME="Magical"
    HELPER_NAME="MagicalHelper"
    ;;
  *)
    echo "Unknown bundle id: $BUNDLE_ID" >&2
    echo "Use com.alexhaslam.magimail or com.alexhaslam.magical." >&2
    exit 2
    ;;
esac

APP_PATH="/Applications/$APP_NAME.app"
TMP_FILE="$(mktemp -t notification-response-trace)"
LOG_PID=""

cleanup() {
  if [ -n "$LOG_PID" ] && kill -0 "$LOG_PID" 2>/dev/null; then
    kill "$LOG_PID" 2>/dev/null || true
    wait "$LOG_PID" 2>/dev/null || true
  fi
  rm -f "$TMP_FILE"
}
trap cleanup EXIT

PREDICATE="(process == \"usernoted\" AND (eventMessage CONTAINS[c] \"Received response\" OR eventMessage CONTAINS[c] \"Bringing app\" OR eventMessage CONTAINS[c] \"$BUNDLE_ID\" OR eventMessage CONTAINS[c] \"delegate.$BUNDLE_ID\")) OR (process == \"usernotificationsd\" AND (eventMessage CONTAINS[c] \"$BUNDLE_ID\" OR eventMessage CONTAINS[c] \"delegate.$BUNDLE_ID\")) OR process == \"$HELPER_NAME\" OR process == \"$APP_NAME\""

echo "== Processes =="
ps -axo pid,ppid,comm | grep -E "($APP_NAME|$HELPER_NAME)( |$)" | grep -v grep || {
  echo "  Neither $APP_NAME nor $HELPER_NAME is running."
}
echo

echo "== Bundle identity =="
if [ -d "$APP_PATH" ]; then
  codesign -dv --verbose=4 "$APP_PATH" 2>&1 | grep -E '^(Identifier|TeamIdentifier|Authority)=' || true
  if [ -x "$APP_PATH/Contents/MacOS/$HELPER_NAME" ]; then
    echo "  helper:"
    codesign -dv --verbose=4 "$APP_PATH/Contents/MacOS/$HELPER_NAME" 2>&1 | grep -E '^(Identifier|TeamIdentifier|Authority)=' || true
  fi
else
  echo "  $APP_PATH not found."
fi
echo

if [ "$MODE" = "past" ]; then
  echo "== Response trace, last $PAST_DURATION =="
  log show --last "$PAST_DURATION" --style compact --predicate "$PREDICATE" 2>&1 || true
  exit 0
fi

echo "== Live response trace =="
echo "Waiting for a notification response."
echo "Click the banner body, or press Archive, Mark Read or Delete."
echo "Press Return here when you have done it."
echo

log stream --style compact --level debug --predicate "$PREDICATE" >"$TMP_FILE" 2>&1 &
LOG_PID=$!

read -r

kill "$LOG_PID" 2>/dev/null || true
wait "$LOG_PID" 2>/dev/null || true
LOG_PID=""

cat "$TMP_FILE"
