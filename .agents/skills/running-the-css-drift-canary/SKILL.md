---
name: running-the-css-drift-canary
description: Check that the stylesheets Magimail and Magical inject into Gmail and Calendar still match the live pages, by diffing screenshots against saved ground truth. Use when dark mode, the hidden chrome, the companion rail or a panel's background looks wrong, after changing css.ts, calendar-css.ts, dark-mode.json or the dark-mode manifest, or when a suspected Google DOM change has to be confirmed or cleared.
---

# Running the CSS drift canary

Both apps lay a stylesheet over Google's page. `apps/magimail/src/css.ts` composes the base
integration, the dark-mode inversion and its per-element resets, the ad and companion-sidebar hiding,
and the subframe rules. `apps/magical/src/calendar-css.ts` composes its base rules, the transparency
that lets AppKit vibrancy through, and the companion-rail hiding. Both build label clauses through the
action map, so a clause carries a `:lang()` scope.

`css.test.ts` and `calendar-css.test.ts` prove we generate the rules we mean. Nothing in either can say
whether Google still _matches_ them, and a rule that stops matching is not an error — it is a rule that
does nothing, so the page goes back to opaque white, chrome we hid returns, or a panel goes translucent
over the desktop. A rule that starts matching too much is worse: the bare `[aria-label*="ad"]` clause
once matched every inbox row and would have hidden the mail.

Screenshots catch all of it at once and need no oracle — it is only pixels. This is how to keep a ground
truth and re-check against it. [`running-the-dom-drift-canary`](../running-the-dom-drift-canary/SKILL.md)
does the same job for the action hooks.

## 1. Give it the same page every time

A diff only means something if the only thing that changed is what you are testing:

- **Launch the app in demo mode, on its debug port.** Run the executable directly, **not**
  `open -a … --args`: `open` goes through LaunchServices, which activates or reuses a running copy of
  the same app and can drop the flags, so you end up capturing the real profile:

  ```bash
  nohup /Applications/Magimail.app/Contents/MacOS/Magimail --demo --debug-port=9222 >/tmp/magimail-demo.log 2>&1 &
  nohup /Applications/Magical.app/Contents/MacOS/Magical   --demo --debug-port=9223 >/tmp/magical-demo.log  2>&1 &
  ```

  `--demo` resolves userData to `Magimail-demo` / `Magical-demo` and keeps the run clear of the App
  Group, so it cannot read or write the real install's accounts. That clearance is a code change
  (`appGroupContainerPath()` returns null in demo mode), so an install built before it still reads
  the real `.../Group Containers/<team>.group.com.alexhaslam.magimail/accounts.json` and captures
  your own mailbox. Confirm the account it shows is the one in
  `~/Library/Application Support/<App>-demo/accounts.json`; if it is not, rebuild and reinstall.

- **Raise the account-suspend timeout first.** Both apps release an account's renderer once it has
  been left alone for `inactiveAccountSuspendMinutes` — 5 by default, and `0` keeps every visited
  account resident. Capture past that point and the page is taken away mid-run, so a diff reports a
  difference that is a released view rather than a rendering. Set it to `0` for the demo profile
  before capturing the ground truth, and again before re-checking: in the app's own Settings,
  **Memory → "Unload inactive after" → "Never"**. There is no CLI flag or environment override for
  it, and on a signed build `settings.json` is encrypted, so the Settings window is the way in.

- **Signing in is the user's job, not yours.** `--demo` points at a separate profile; it signs nobody
  in, and neither app seeds a mailbox. If the page is Google's sign-in rather than a mailbox, **stop
  and say so** — ask the user to sign in as the demo account, once, and run the canary after. Never
  attempt the login yourself. The demo account's mailbox is the seeded, unchanging one, which is what
  stops a new timestamp or an unread count being reported as drift — that is a property of the
  account, not of `--demo`.

- **Never pass `--css-override`** — the flag `pnpm run magimail:debug` sets. It _replaces_ the composed
  sheet rather than adding to it, so a shot taken under it is the override, not the stylesheet the app
  ships.
- **Know which theme you are capturing.** Magimail inverts the page itself, so its light and dark
  stylesheets are different code paths and each needs its own ground truth. Magical deliberately has no
  dark-mode stylesheet: Google Calendar honours `prefers-color-scheme`, which the app drives from macOS,
  so capture Calendar under each system appearance rather than expecting a CSS switch.
- **Use the same view.** For Magimail: the inbox, a thread, the compose window, Settings. For Magical:
  the day and week views, an open event panel, and the companion rail both shown and hidden. Each
  exercises different rules, so capture a named shot per view rather than one of "Gmail".
- **Keep the window the same size**, and the same display. The window bounds are what gets captured, so
  a resize is a difference in every layout pixel, and a Retina capture does not compare against one
  taken on a standard display.

## 2. Lay the ground truth down once

The ground truth is a directory of shots **outside the repo**, at `~/.css-ground-truth/`, one file per
app, view and appearance, plus a note of where they came from:

```
~/.css-ground-truth/
  magimail-inbox-light.png
  magimail-inbox-dark.png
  magical-week.png
  BUILD                     which build and date these were captured from
```

Outside the repo because a shot is a property of this machine's window size and display rather than of
the branch: a set captured on one Mac will not diff clean on another, so it is not a thing to commit.

**If the directory is already populated, this step is done — stop.** Running it again overwrites the
only reference there is, and the whole point is that it holds the _previous working_ rendering. Laying
a baseline down is not part of checking; it is the one thing that happens before checking exists.

The first time, and each time you deliberately adopt a new rendering:

```bash
mkdir -p ~/.css-ground-truth
node tools/cdp-eval.mjs --port 9222 --screenshot ~/.css-ground-truth/magimail-inbox-light.png
node tools/cdp-eval.mjs --port 9223 --screenshot ~/.css-ground-truth/magical-week.png
printf '%s %s\n' "$(date +%F)" "$(defaults read /Applications/Magimail.app/Contents/Info CFBundleShortVersionString)" > ~/.css-ground-truth/BUILD
```

Capture it from a build you have looked at with your own eyes, and write down which one: "this differs
from the baseline" means nothing unless the baseline is known good. A rule that matches too much looks
perfectly calm once the baseline was taken while it was broken.

## 3. Re-check

```bash
node tools/cdp-eval.mjs --port 9222 --screenshot /tmp/magimail-inbox-light-now.png
cmp -s ~/.css-ground-truth/magimail-inbox-light.png /tmp/magimail-inbox-light-now.png \
  && echo same || echo differs
```

`cmp` is enough for the smoke signal, because the same render produces the same PNG bytes. When it
differs, **open both images** — the answer is usually visible in two seconds, and it is the only step
that says _what_ moved. Then decide which of the three it is:

- **Google moved something.** The page renders differently under our rules; the rule that owned it is
  written down in `docs/magimail/dark-mode.md` or `docs/magical/overview.md`.
- **Our rules changed.** Replacing that one baseline _is_ the deliberate act: look at both images,
  satisfy yourself the new rendering is the one you want, copy the scratch shot over the baseline, and
  update `BUILD` in the same breath. Never do it to clear a diff you have not explained.
- **The state changed, not the page.** A different day, a different thread open. That is a false
  positive: re-shoot the same view before believing it.

## 4. What makes it lie

Every one of these reports drift when nothing has:

- **Timestamps, unread counts, avatars and ads change on their own.** A seeded demo mailbox holds most
  of that still, which is why the canary runs there; for what still moves, crop to the region the rule
  owns rather than diffing the whole page.
- **A different window size or display** fails everything at once, which is why the ground truth lives
  outside the repo and is per-machine.
- **A rule that matched too much can look calm.** Hiding every row is not a crash; it is a rendering
  that matches the ground truth if the ground truth was taken while it was broken.
- **Calendar's appearance is not ours.** Its theme comes from macOS, so a shot taken in the other
  system appearance is a difference in every pixel and says nothing about our rules.

A diff says "different", never "which rule". Treat it as the thing that sends you to the live page, and
use `tools/cdp-eval.mjs --css` there to see which rule is actually applying.
