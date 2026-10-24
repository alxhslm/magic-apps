---
name: testing-native-subsystems
description: Verify a change that crosses the native boundary locally. Use when testing the Electron Main to Swift helper RPC, forcing a notification or deep link, checking macOS Settings and tray UI, or confirming the packaged app behaves like the source.
---

# Testing native subsystems

Unit tests in Vitest cover the TypeScript layer, and Swift unit tests cover isolated Swift
types, but neither catches failures at the process boundary. Magimail and Magical split
work across Electron Main, a compiled Swift helper on `stdin`/`stdout` JSON-RPC, a C++
N-API addon managing Cocoa titlebars, and native macOS services (`UNUserNotificationCenter`,
AppKit, and LaunchServices).

Use this skill to verify cross-process integrations and native UI locally without manual
clicking or waiting for live cloud sync.

## Route what to test

| Subsystem to test               | Tool / Command                                                                               | What it verifies                                                                           |
| :------------------------------ | :------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- |
| **Notification & deep links**   | `open "magimail://thread/<id>?account=<id>"`                                                 | The whole notification-click path, without a notification                                  |
| **Live Gmail / Calendar DOM**   | `node tools/cdp-eval.mjs [--port 9223] "<expr>"`                                             | What an account view actually rendered, and what its DOM contains                          |
| **Swift helper stdio JSON-RPC** | `.agents/skills/testing-native-subsystems/scripts/test-helper-rpc.sh [app]`                  | Standalone helper execution, request handling, and JSON response                           |
| **Alert scheduling & muting**   | `pnpm --filter magical run test:native`                                                      | Alert pipeline, settings schema, helper dispatch, and that every alert button Main acts on |
| **Banners & action contract**   | `pnpm --filter magimail run test:native`                                                     | Banner dispatch, and that every banner button Main acts on                                 |
| **Native Settings UI & layout** | `.agents/skills/testing-native-subsystems/scripts/inspect-native-ui.sh [app] [--screenshot]` | Accessibility tree, control counts, dimensions, and visual snapshot                        |
| **Live Main & Helper logs**     | `tail -f ~/Library/Logs/<App>/main.log`                                                      | Chronological log multiplexing Main and Swift helper stderr                                |

## 0. Before the first run in a fresh worktree

`pnpm run typecheck` and `pnpm run test` both fail in a newly created worktree until
`@magimail/core` is built, because the apps import its compiled `dist/`:

```bash
pnpm install
pnpm --filter @magimail/core run build
```

If the Electron tests fail with `Electron failed to install correctly`, or a
`dyld` error about `Electron Framework`, the binary did not unpack. Re-run its
installer rather than reinstalling the workspace:

```bash
node node_modules/.pnpm/electron@*/node_modules/electron/install.js
```

## 1. Deep links: the notification path without a notification

**Reach for this first.** A `magimail://` or `magical://` URL enters `performThreadAction`
and `openDeepLink` at exactly the point a notification click does, so `open` exercises the
real path from the shell, with no waiting and no Notification Center automation:

```bash
# Magimail: open a thread in a named account. Same call a banner click makes.
open "magimail://thread/<threadId>?account=<accountId>"

# Magical: reveal an event. `eid` is the `eid=` query parameter of the event's htmlLink.
open "magical://event?account=<accountId>&eid=<eid>&at=<ISO start>"
```

Account ids come from the app's own state, not from Google:

```bash
cat ~/Library/Application\ Support/Magimail/accounts.json
cat ~/Library/Application\ Support/Magical/accounts.json
```

**Cold and warm are different code paths, and only cold matters.** A deep link arrives
when the user has not been looking at that account, so its view is suspended and the
wake path runs. Testing warm hides the bugs. Force a cold view by relaunching
(`pnpm run magical:debug`), because accounts load lazily at startup; the alternative is
waiting out `inactiveAccountSuspendMinutes`, which defaults to 10.

Deep links only ever _open_. `archive`, `trash` and `markRead` reach `performThreadAction`
solely from a notification action button or a menu bar popover row, so they need
[Native UI and layout verification](#4-native-ui-and-layout-verification).

## 2. Live Gmail and Calendar DOM over CDP

Both apps accept `--debug-port`, and their account views are ordinary Chromium page
targets. This is the only way to see what Google's own DOM is doing.

```bash
pnpm run magimail:debug        # port 9222, plus a live CSS override file
pnpm run magical:debug         # port 9223

node tools/cdp-eval.mjs "location.hash"
node tools/cdp-eval.mjs --port 9223 "location.pathname"
node tools/cdp-eval.mjs --target work "document.title"      # name the account
node tools/cdp-eval.mjs --count '[role="dialog"]'
node tools/cdp-eval.mjs --screenshot /tmp/view.png
```

With more than one account awake, the first Gmail target is whichever the debugger lists
first; `--target <title substring>` says which one you meant.

**Prove a route was same-document rather than a reload** by planting a marker and
checking it survives. A hash assignment keeps an open compose alive; a `loadURL` does not:

```bash
node tools/cdp-eval.mjs "window.__m='alive'; 'planted'"
open "magimail://thread/<id>?account=<id>"
node tools/cdp-eval.mjs "window.__m || 'GONE - page reloaded'"
```

**Count hash changes to prove a shortcut fired**, rather than inferring it from the final
URL. A route that leaves and returns ends where it started and looks like a no-op:

```bash
node tools/cdp-eval.mjs "window.__n=0; addEventListener('hashchange',()=>window.__n++); 'armed'"
# ...trigger the action...
node tools/cdp-eval.mjs "window.__n"
```

### Check a live-DOM predicate against the resting page before trusting it

Code that waits for a toast, a dialog or a control generally asks
`document.querySelector(...)` and treats a hit as proof the mutation landed. Both Gmail
and Calendar keep permanent, empty live regions in the DOM, so such a predicate can be
true before anything happens, and the wait it guards silently becomes a fixed delay.

Paste the predicate verbatim into `cdp-eval` on an idle page. If it is already true, the
wait is not measuring what it claims:

```bash
node tools/cdp-eval.mjs "(() => {
  const el = document.querySelector('[role=\"alert\"], [aria-live=\"polite\"], [role=\"status\"]');
  return JSON.stringify({ alreadyTrue: !!(el && el.offsetParent !== null), text: (el&&el.textContent||'').slice(0,40) });
})()"
```

Gmail's first match is an empty but laid-out `div`; Calendar's first match holds the text
`Loading...`. Both satisfy the usual checks with no action in flight.

## 3. Swift helper JSON-RPC

Both apps use `HelperRPC` over standard pipes. Test endpoints directly via the script or
by piping JSON into the binary:

```bash
# Via helper script
.agents/skills/testing-native-subsystems/scripts/test-helper-rpc.sh magical
.agents/skills/testing-native-subsystems/scripts/test-helper-rpc.sh magimail

# Or raw stdio
echo '{"id":1,"method":"defaults.query","params":{}}' | /Applications/Magical.app/Contents/MacOS/MagicalHelper
```

A working helper returns `{"id": <n>, "result": ...}` on `stdout` and logs
`LEVEL|Category|message` diagnostics to `stderr`.

Requests the helper sends _to_ Main, such as `tray.threadAction`, `tray.showThread`
and `tray.compose`, cannot be injected this way. Main spawns the helper and reads
its stdout, so there is no pipe to write into from outside.

## 4. Native UI and layout verification

AppKit and SwiftUI windows are invisible to web devtools but exposed to the macOS
Accessibility (`AX`) tree. Run the inspection script to verify window bounds, control
counts, and capture snapshots:

```bash
.agents/skills/testing-native-subsystems/scripts/inspect-native-ui.sh magical --screenshot
```

To toggle controls deterministically via AppleScript without mouse clicks:

```bash
osascript -e 'tell application "System Events" to tell process "MagicalHelper" to tell window "Magical Settings" to tell group 1 of group 1 to tell scroll area 1 to click checkbox 1'
```

**Only the Settings window is reachable this way.** It is a real `NSWindow`. The menu bar
popover is an `NSPopover` and never appears in the helper's `windows`, so its rows and
their action buttons cannot be driven by System Events; `count of UI elements` returns
just the menu bar item. Clicking the menu bar item itself does work, and is what opens
the popover:

```bash
osascript -e 'tell application "System Events" to tell process "MagimailHelper" to click menu bar item 1 of menu bar 1'
```

**A notification banner stays on screen for roughly a second**, and it belongs to the
`NotificationCenter` process rather than to the app. Detecting it and reading it must
happen inside one `osascript` run; a second invocation finds it gone.

## 5. Live Google Workspace MCP testing

When using the Gmail and Google Calendar connectors to test live sync:

1. **Ask first**: Confirm consent and target account/calendar with the user before writing.
2. **Distinct prefix**: Use `[Magical Test] <Title>` or `[Magimail Test] <Subject>`.
3. **Immediate cleanup**: Delete created test events and messages straight after verifying.
4. **Never fall back silently**: If MCP is unauthenticated or times out, report the failure
   and its drawbacks explicitly (local simulation tests scheduler and UI, but skips live
   Google wire sync and network timing) and ask the user how to proceed.

Tool names are `send_message`, `search_threads`, `get_thread` and `trash_thread` for
Gmail, and `create_event`, `list_calendars` and `delete_event` for Calendar. Check which
account the connector is authenticated as before choosing an app account to target; it is
one account, and the app usually has several.

### 5.1 Live calendar alert recipe (Magical)

1. **Calculate start time**: `AlertScheduler` ignores events whose fire moment is further out
   than `MAX_TIMER_MS` (10 minutes). With a default 5-minute lead time, create the event
   `7` to `9` minutes in the future so `fireAt` lands `2` to `4` minutes from now.
2. **Create the event**:
   ```json
   {
     "calendarId": "primary",
     "summary": "[Magical Test] E2E Alert Verification",
     "start": { "dateTime": "<now + 8m ISO>" },
     "end": { "dateTime": "<now + 38m ISO>" }
   }
   ```
3. **Trigger the poll**: The background poller runs every 5 minutes; toggle `meetingAlertsEnabled`
   off and on via AppleScript to trigger `applySettings()` and force an immediate poll:
   ```bash
   osascript -e 'tell application "System Events" to tell process "MagicalHelper" to tell window "Magical Settings" to tell group 1 of group 1 to click checkbox 1'
   sleep 0.5
   osascript -e 'tell application "System Events" to tell process "MagicalHelper" to tell window "Magical Settings" to tell group 1 of group 1 to click checkbox 1'
   ```
4. **Verify log signatures in `~/Library/Logs/Magical/main.log`**:
   - **Arming**: `(AlertScheduler) ... armed 1, dropped 0, 1 pending ... soonest <id> fires <ISO> in <N>s`
   - **Muting**: Click the calendar's checkbox in `scroll area 1`:
     ```bash
     osascript -e 'tell application "System Events" to tell process "MagicalHelper" to tell window "Magical Settings" to tell group 1 of group 1 to tell scroll area 1 to click checkbox 1'
     ```
     Verify log: `(AlertScheduler) ... dropped 1`. Re-click to re-arm: `(AlertScheduler) ... armed 1`.
   - **Firing**: When the clock reaches `fireAt`, observe on the millisecond:
     - `(AlertScheduler) Firing <id> from <sourceId>, 5 min before start`
     - `(NotificationManager) Posting banner for <id>, join button no`
     - `(SwiftHelper) (RPC) Dispatching request: alert.dispatch`
5. **Delete event**: Call `delete_event` with `calendarId` and the created `eventId`.

### 5.2 Live email arrival recipe (Magimail)

Run `pnpm --filter magimail run test:native` first. It exercises the helper RPC and checks the
banner buttons against what Main acts on without needing any mail at all, so a live run is
only worth doing for what it cannot cover: the Atom feed, the poll timing, and the banner
itself.

1. **Send a test message**: `send_message` with subject `[Magimail Test] <what you are checking>`.
2. **Force the poll**. `pollIntervalSeconds` defaults to **900**, so a message sent now
   raises its banner up to fifteen minutes later; a run that "produced no notification"
   has usually just not reached the next cycle. Either lower `pollIntervalSeconds` in
   `~/Library/Application Support/Magimail/settings.json` and restart, or wait for the
   cycle and watch for it.
3. **Verify the dispatch**: the banner shows in the log as
   `(SwiftHelper) (RPC) Dispatching request: notify.dispatch`, not as the word
   "notification"; grepping for "notification" misses it.
4. **Trash the message**: `trash_thread` with the resulting `threadId`.
