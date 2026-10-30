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
#   tools/notification-response-trace.sh [bundle-id] [seconds]
#
# The bundle id defaults to Magimail. Without a duration it waits for Return. With one
# it captures for that many seconds, so an agent can run it without an interactive
# prompt:
#   tools/notification-response-trace.sh com.alexhaslam.magimail 240
#
# usernoted's response lines are debug-level and are not written to the log store, so
# there is deliberately no retrospective mode: it would return an empty result that
# looks like "no response was received".

set -euo pipefail

BUNDLE_ID="${1:-com.alexhaslam.magimail}"
DURATION="${2:-}"

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
    echo "Usage: $0 [com.alexhaslam.magimail|com.alexhaslam.magical] [seconds]" >&2
    exit 2
    ;;
esac

if [ -n "$DURATION" ] && ! [[ "$DURATION" =~ ^[0-9]+$ ]]; then
  echo "Duration must be a whole number of seconds: $DURATION" >&2
  exit 2
fi

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

PREDICATE="(process == \"usernoted\" AND (eventMessage CONTAINS[c] \"Received response\" OR eventMessage CONTAINS[c] \"Notifying UserNotifications client\" OR eventMessage CONTAINS[c] \"Bringing app\" OR eventMessage CONTAINS[c] \"$BUNDLE_ID\" OR eventMessage CONTAINS[c] \"delegate.$BUNDLE_ID\")) OR (process == \"usernotificationsd\" AND (eventMessage CONTAINS[c] \"$BUNDLE_ID\" OR eventMessage CONTAINS[c] \"delegate.$BUNDLE_ID\")) OR process == \"$HELPER_NAME\" OR process == \"$APP_NAME\""

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

echo "== Live response trace =="
echo "Waiting for a notification response."
echo "Click the banner body, or press Archive, Mark Read or Delete."
if [ -n "$DURATION" ]; then
  echo "Capturing for $DURATION seconds."
else
  echo "Press Return here when you have done it."
fi
echo

log stream --style compact --level debug --predicate "$PREDICATE" >"$TMP_FILE" 2>&1 &
LOG_PID=$!

if [ -n "$DURATION" ]; then
  sleep "$DURATION"
else
  read -r
fi

kill "$LOG_PID" 2>/dev/null || true
wait "$LOG_PID" 2>/dev/null || true
LOG_PID=""

cat "$TMP_FILE"
