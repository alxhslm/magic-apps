#!/usr/bin/env bash
#
# Launches the installed Magimail with a remote debugging port and a live CSS
# override, then waits until the Gmail page target is attachable and prints it.
#
# The two things that make a UI problem slow to investigate are getting a
# debuggable app at all, and not being able to change the injected CSS without a
# rebuild. This does both in one command:
#
#   pnpm magimail:debug                 # CSS for whichever theme is in effect
#   pnpm magimail:debug --light         # force light mode CSS
#   pnpm magimail:debug --dark          # force dark mode CSS
#   pnpm magimail:debug --port 9223     # alongside another debug session
#   pnpm magimail:debug --demo          # the isolated Magimail-demo profile
#
# `--demo` resolves userData to `Magimail-demo` and keeps the run out of the App
# Group, so it can neither read your accounts nor share a Chromium profile with
# the installed app. Use it for anything that is not about your own mailbox.
#
# With neither --light nor --dark, the mode follows the app's own `theme`
# setting, resolving "system" through macOS. Forcing dark made every session
# start by disagreeing with the app under test for anyone working in light mode.
#
# The app is relaunched, so an already-running Magimail is quit first. The
# override file is left on disk afterwards; edit it and the running app
# re-injects on save.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${MAGIMAIL_APP:-/Applications/Magimail.app}"
PORT=9222
TMP_BASE="${TMPDIR:-/tmp}"
CSS_OUT="${TMP_BASE%/}/magimail-gmail.css"
MODE=""
DEMO=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --light) MODE="--light"; shift ;;
    --dark) MODE="--dark"; shift ;;
    --port) PORT="$2"; shift 2 ;;
    --css) CSS_OUT="$2"; shift 2 ;;
    --demo) DEMO=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

DEMO_ARGS=()
PROFILE_DIR="Magimail"
if [[ "$DEMO" -eq 1 ]]; then
  DEMO_ARGS=("--demo")
  PROFILE_DIR="Magimail-demo"
fi

# Resolve the theme the app is actually running in, so the injected CSS matches
# what is on screen. "system" is whatever macOS reports; AppleInterfaceStyle is
# absent entirely in light mode rather than set to "Light".
if [[ -z "$MODE" ]]; then
  SETTINGS="$HOME/Library/Application Support/$PROFILE_DIR/settings.json"
  THEME="system"
  if [[ -f "$SETTINGS" ]]; then
    THEME=$(/usr/bin/plutil -extract theme raw -o - "$SETTINGS" 2>/dev/null || echo system)
  fi
  case "$THEME" in
    dark) MODE="--dark" ;;
    light) MODE="--light" ;;
    *)
      if [[ "$(defaults read -g AppleInterfaceStyle 2>/dev/null)" == "Dark" ]]; then
        MODE="--dark"
      else
        MODE="--light"
      fi
      ;;
  esac
  echo "==> Theme setting is '$THEME'; using ${MODE#--} mode (override with --dark or --light)"
fi

if [[ ! -d "$APP" ]]; then
  echo "Magimail not installed at $APP" >&2
  echo "Build and install it with: pnpm magimail:install" >&2
  exit 1
fi

echo "==> Dumping injected CSS ($MODE)"
node "$SCRIPT_DIR/dump-gmail-css.mjs" "$MODE" -o "$CSS_OUT"

if pgrep -f "$APP/Contents/MacOS/Magimail" >/dev/null 2>&1; then
  echo "==> Quitting running Magimail"
  osascript -e 'quit app "Magimail"' || true
  for _ in $(seq 1 20); do
    pgrep -f "$APP/Contents/MacOS/Magimail" >/dev/null 2>&1 || break
    sleep 0.5
  done
fi

if [[ "$DEMO" -eq 1 ]]; then
  echo "==> Launching with --debug-port=$PORT --css-override=$CSS_OUT --demo (isolated $PROFILE_DIR profile)"
else
  echo "==> Launching with --debug-port=$PORT --css-override=$CSS_OUT"
fi
open -a "$APP" --args "--debug-port=$PORT" "--css-override=$CSS_OUT" ${DEMO_ARGS[@]+"${DEMO_ARGS[@]}"}

echo "==> Waiting for the Gmail page target"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/json/list" 2>/dev/null | grep -q 'mail.google.com'; then
    echo
    echo "Attached:  http://127.0.0.1:$PORT/json/list"
    echo "Edit CSS:  $CSS_OUT   (saves re-inject automatically)"
    echo "Re-dump:   node $SCRIPT_DIR/dump-gmail-css.mjs $MODE -o $CSS_OUT"
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for a Gmail target on port $PORT." >&2
echo "Check the log at ~/Library/Logs/Magimail for a startup failure." >&2
exit 1
