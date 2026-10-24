---
name: running-the-dom-drift-canary
description: Run the canary that checks the action maps' strong DOM hooks against the live Gmail and Calendar pages. Use when a mapped control stops working, after changing a hook in an app's dom-labels.json, or when a suspected Google DOM change has to be confirmed or cleared.
---

# Running the DOM drift canary

`tools/dom-drift.mjs` resolves every strong hook the apps drive Google's controls through, using the
same page-side `findAction`, and compares the control it lands on against the English accessible name
read off a signed-in English account. English is the oracle, never a matcher: no page the apps drive
reads it, and the tool reads no map label for a hook.

It catches the failure the unit tests cannot see. A test can prove the map is well formed; nothing in
a test can tell you whether `div[act="7"]` is _still_ Gmail's Archive button. A hook Google moves does
not stop matching — it resolves to the wrong control, and the app drives the wrong thing, silently.

[`dom-labels.md`](../../../docs/shared/dom-labels.md#drift-canary) says what the tool is. This is how
to give it a page, read a red run, and reach the states it cannot reach itself.

## 1. Give it something to read

Everything below is load-bearing:

- **The core built**, because the preamble is loaded from the package's built entry:
  `pnpm --filter @magimail/core run build`.
- **The app running in demo mode, with its debug port.** Start it by running the executable
  directly, **not** `open -a … --args`: `open` goes through LaunchServices, which activates or
  reuses a running copy of the same app and can drop the flags, so you end up driving the real
  profile instead of a demo one. Run these from a separate shell; each is its own OS process with
  its own userData:

  ```bash
  nohup /Applications/Magimail.app/Contents/MacOS/Magimail --demo --debug-port=9222 >/tmp/magimail-demo.log 2>&1 &
  nohup /Applications/Magical.app/Contents/MacOS/Magical   --demo --debug-port=9223 >/tmp/magical-demo.log  2>&1 &
  ```

  `--demo` resolves userData to `Magimail-demo` / `Magical-demo` and keeps the run clear of the App
  Group, so it cannot read or write the real install's accounts. Its mailbox is seeded and
  unchanging, which is what makes a check repeatable, and it keeps the canary off your own mail.
  (`pnpm run magimail:debug` opens the real profile instead — fine for a one-off look, wrong for a run
  you mean to compare against the last one.)

- **A build that carries the demo gate.** "Keeps clear of the App Group" is a code change, not a
  property of the flag: `appGroupContainerPath()` returns null in demo mode
  (`apps/magimail/src/native-widgets.ts`, `apps/magical/src/accounts.ts`). An install built before
  that change still reads the real
  `~/Library/Group Containers/<team>.group.com.alexhaslam.magimail/accounts.json`, so a `--demo` run
  comes up on the real account and the real partition — the canary then reads your own mail. Before
  trusting a run, confirm the account it shows is the one in
  `~/Library/Application Support/<App>-demo/accounts.json`, not the one in the group container. If
  they disagree, rebuild and reinstall the app (see
  [`building-and-signing`](../../../docs/shared/building-and-signing.md)) rather than running.

- **Raise the account-suspend timeout before you run it.** Both apps release an account's renderer
  once it has been left alone for `inactiveAccountSuspendMinutes` — 5 by default, and `0` keeps every
  visited account resident. A canary run outlives a short one, and a view released mid-run reports
  every check as `skip`, which reads exactly like a page that offered nothing. A `1` here is how this
  was met: the run passed the moment it was started straight after launch and skipped nothing about
  the page. Set it to `0` for the demo profile first: in the app's own Settings, **Memory → "Unload
  inactive after" → "Never"**. There is no CLI flag or environment override, and on a signed build
  `settings.json` is encrypted, so the Settings window is the way in.

- **A signed-in English account.** The tool refuses to run when `document.documentElement.lang` is
  not `en`, because the oracle does not exist in another language. Never force `hl=en` to satisfy
  it; the whole point of the maps is that the user's own language works. The demo profile is no
  exception: unauthenticated it reaches a login page and every check fails, so confirm it is signed
  in before believing a run.

## 2. Run it

```bash
node tools/dom-drift.mjs --app magimail      # 9222
node tools/dom-drift.mjs --app magical       # 9223
```

`--port` overrides the default, and `--target <title substring>` picks the account when more than one
view is awake. On an account with several tabs signed in, name the one you mean rather than trusting
the first target the debugger lists.

The run raises the demo app to the front — stealing focus from whatever you are doing — because Google
ignores a click delivered to a window that is not the frontmost application. Without that, Gmail lays
no list toolbar out for a selected row and every Calendar panel check reports "a chip was laid out but
its panel never opened", which reads like drift but is only a background window. The tool does this
itself (macOS System Events); it is why a run must not be babysat while you work in another window.

## 3. Read it

- **pass** — resolved through the band the map names, and the control's accessible name still agrees.
- **fail** — resolved through the wrong band, resolved ambiguously, or landed on a name that does not
  agree. **This is a finding, not a flake.** Re-measure the control in the live page with
  `tools/cdp-eval.mjs`, then correct the map. Do not weaken the tool to clear it.
- **skip** — the control is not rendered in the view. The tool reaches the states it can and names
  each one it could not, but a run that is mostly skips proves almost nothing. Give it the state.

The tool only ever resolves and compares. It never activates the control it is checking, so a red run
cannot change your mail or your calendar.

## 4. Reach the states it cannot reach itself

**The demo calendar is empty, so there is no panel to open** — and the delete and RSVP checks only lay
out with one. Seed a chip: create an event on the calendar the connector is signed in to, and **invite
the account the demo profile is signed in to**. The invitation lands on the demo calendar as a chip
whose panel carries the delete control and, being unanswered, all three RSVP buttons. The two
addresses are not interchangeable: it is the invitee that has to be the demo account.

Run it from a fresh process, because a long-running session's gateway may not carry the connector:

```bash
pi -p --no-session "Use the google-workspace MCP tools. Create an event on the primary calendar titled
'[Magical Test] canary' from <start> to <end>, with attendee <demo account>. Print ONLY one JSON line:
{\"eventId\":\"...\"}"
```

Take both addresses from the apps rather than guessing: the connector's comes back with its account
details, and the demo profile's is the account the app shows once it is signed in. Then **wait for the
chip to appear in the grid** before running the canary — the calendar polls, so a run made immediately
finds an empty grid and skips everything.

Delete it afterwards with `sendUpdates: 'all'`, and confirm no `[Magical Test]` events remain.

Two traps, both paid for already:

- **An `eid` is shorter than you expect, and it is not a truncation you can undo.** It is base64url of
  `<eventId> <calendarId>`, but for the primary calendar the value decodes to `<eventId> <address>@m`,
  cut mid-address. That is how it arrives: the raw MCP payload, a direct Calendar API call and the live
  chip all carry the same short form, so nothing is recovered by copying it more carefully.
- **Never rebuild it from the account address.** A rebuilt `eid` matches no chip, which reads exactly
  like a bug in the app. Keep it out of tool output where you can — some tokens are truncated there —
  and build any URL in the shell rather than pasting an id between steps, but do not expect the value
  itself to change: use what the page or the event gives you, verbatim.

**Gmail's `mark read` needs an unread thread.** The list toolbar lays either control out only from a
selection, and `div[act="1"]` appears only on an unread one — an inbox with none skips it, and the
tool cannot create one without changing your mail. Send one to the demo account first:

```bash
pi -p --no-session "Use the google-workspace MCP Gmail tools. Send an email to <demo account> with
subject '[Magimail Test] canary' and body 'DOM drift canary seed. Safe to delete.' Print ONLY one JSON
line: {\"threadId\":\"...\"}"
```

Wait for it to reach the inbox, then trash it afterwards. It has to be in the view the tool scans — an
inbox with no unread mail is not the state, and neither is unread mail in another tab. The tool
selects every row in turn, so the first unread thread it reaches is enough.

## 5. What it cannot do

- **It cannot run on a hosted CI runner.** It needs a signed-in session, and there is no OAuth by
  design, so there is no way to script the login. It needs a running Electron app with a debug port
  too. Run it locally against a running app instance.
- **It is not a merge gate.** A red run means a person has to look at what Google changed, which is
  not a reason to fail an unrelated pull request.
