#!/usr/bin/env bash
#
# Launches the installed Magical with a remote debugging port, then waits until
# the Calendar page target is attachable and prints it.
#
#   pnpm magical:debug                 # port 9223
#   pnpm magical:debug --port 9224     # alongside another debug session
#   pnpm magical:debug --demo          # the isolated Magical-demo profile, not your accounts
#
# `--demo` is the safe way to poke at a real defect: it resolves userData to
# `Magical-demo` and keeps the run out of the App Group, so it can neither read
# your accounts nor share a Chromium profile with the installed app.
#
# The port defaults to 9223 rather than 9222 so Magical and Magimail can both be
# attached at once; the two apps are usually debugged together, because a deep
# link or an alert crosses from one to the other.
#
# There is no CSS override here, unlike Magimail's script: Magical injects its
# Calendar CSS from `calendar-css.ts` and has no live override file to watch.
#
# The app is relaunched, so an already-running Magical is quit first.
set -euo pipefail

APP="${MAGICAL_APP:-/Applications/Magical.app}"
PORT=9223
DEMO=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --demo) DEMO=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

DEMO_ARGS=()
if [[ "$DEMO" -eq 1 ]]; then
    DEMO_ARGS=("--demo")
fi

if [[ ! -d "$APP" ]]; then
  echo "Magical not installed at $APP" >&2
  echo "Build and install it with: pnpm magical:install" >&2
  exit 1
fi

if pgrep -f "$APP/Contents/MacOS/Magical" >/dev/null 2>&1; then
  echo "==> Quitting running Magical"
  osascript -e 'quit app "Magical"' || true
  for _ in $(seq 1 20); do
    pgrep -f "$APP/Contents/MacOS/Magical" >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

if [[ "$DEMO" -eq 1 ]]; then
    echo "==> Launching with --debug-port=$PORT --demo (isolated Magical-demo profile)"
else
    echo "==> Launching with --debug-port=$PORT"
fi
open -a "$APP" --args "--debug-port=$PORT" ${DEMO_ARGS[@]+"${DEMO_ARGS[@]}"}

echo "==> Waiting for the Calendar page target"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/json/list" 2>/dev/null | grep -q 'calendar.google.com'; then
    echo
    echo "Attached:  http://127.0.0.1:$PORT/json/list"
    echo "Inspect:   node tools/cdp-eval.mjs --port $PORT 'location.pathname'"
    exit 0
  fi
  sleep 1
done

# A suspended account has no renderer, so a target can be legitimately absent.
# Say which case this is rather than reporting a failure that may not be one.
if curl -fsS "http://127.0.0.1:$PORT/json/list" >/dev/null 2>&1; then
  echo "Debugger is up on $PORT, but no Calendar target appeared." >&2
  echo "Every account may be suspended; switch to one in the app, then retry." >&2
else
  echo "Timed out waiting for the debugger on port $PORT." >&2
  echo "Check the log at ~/Library/Logs/Magical for a startup failure." >&2
fi
exit 1
