---
name: debugging-the-app
description: Diagnose a defect in a running Magimail or Magical build. Use when something looks or behaves wrong in the app rather than in a test; Gmail styled incorrectly, a missing toolbar, a dead settings window or tray, a widget or Share sheet returning nothing, or a launch that produces no window.
---

# Debugging the app

Find the process first, then look inside it. Magimail runs across Electron Main, a renderer
under injected CSS, a C++ N-API addon, a Swift helper and three OS-hosted extensions, and
every one of them fails in a way that looks like an Electron bug from the outside. Reading
TypeScript answers almost none of these questions, because the answer is in a live page, a
Swift helper on stderr, or a sandboxed extension that cannot be called into at all. Magical
has the same shape without the extensions.

## Route the symptom

| Symptom                                                            | Process                       | Where to look                                                         |
| :----------------------------------------------------------------- | :---------------------------- | :-------------------------------------------------------------------- |
| Gmail is the wrong colour, spacing or an icon is invisible         | Renderer, under injected CSS  | Attach and query the page; see below                                  |
| No toolbar, broken drag, account switcher rendered as loose labels | N-API addon, in Electron Main | `apps/magimail/native/src/magimail_addon.mm`, then `main.log`         |
| Settings window, tray or a notification does nothing               | Swift helper                  | `main.log`, where helper stderr arrives as `LEVEL\|Category\|message` |
| Share sheet, widget or Focus Filter is stale, empty or wrong       | An OS-hosted `.appex`         | **Help → Reveal Logs in Finder**, then the per-extension log          |
| Window opens with no Gmail view, and no CDP target ever appears    | Missing native artefacts      | The worktree has never built them; see the guidelines                 |

That last one wastes a whole cycle if you take it at face value. A worktree that has never
built the native artefacts aborts account initialisation with an unhandled
`Not found: tried …`, and nothing else says so.

## Gmail UI defects: attach, do not read

`pnpm run magimail:debug` attaches to the installed app and prints a CDP endpoint. It quits and
relaunches Magimail to do it, so **ask before running it**; it is the user's mail client.

One fact decides how you work on the CSS, and you cannot discover it from the debugger:
**the winning stylesheet is invisible over CDP.** Magimail injects with `cssOrigin: 'user'`,
which is what lets its rules beat Gmail's author-origin `!important`, and Chromium does not
expose user-origin sheets to a debugger at all. `CSS.getAllStyleSheets` will not list it,
and writing to the page's `<style id="magimail-injected-styles">` element changes nothing.
Devtools alone will therefore tell you a rule is absent when it is winning.

`--css-override=<path>` is the way in.
[`debugging.md`](../../../docs/developer-guidelines/debugging.md), _Debugging the Gmail
UI_, carries the full loop: dump the real stylesheet, edit it against the running app, then
write the result back into `apps/magimail/src/css.ts`. Read it before changing any CSS. It
also carries the habit of counting rather than spot-checking, and the build steps a fresh
worktree needs.

### The rapid CSS iteration loop

1. **Launch with debugging**:
   ```bash
   pnpm run magimail:debug       # dark-mode (default), CDP on 9222, override at /tmp/magimail-gmail.css
   pnpm run magimail:debug --light # light-mode
   ```
2. **Inspect live computed styles, element counts, and screenshots**:

   ```bash
   # Inspect computed styles of matching elements
   node tools/cdp-eval.mjs --css '[role="navigation"]' background-color color display

   # Count elements matching a selector
   node tools/cdp-eval.mjs --count 'img'

   # Evaluate any arbitrary JavaScript expression on the live Gmail page
   node tools/cdp-eval.mjs 'document.querySelectorAll("img").length'

   # Capture a visual screenshot of the live webview
   node tools/cdp-eval.mjs --screenshot /tmp/gmail-view.png

   # Name the account when more than one view is awake
   node tools/cdp-eval.mjs --target Work 'location.hash'
   ```

   Each account is its own page target, so with several awake the default is
   whichever the debugger lists first. `--target` matches on the page title,
   which carries the address.

   A query can land while the app is tearing an account's view down. Both apps release an
   idle account's renderer after `inactiveAccountSuspendMinutes`, which closes the debugger
   socket without answering the command in flight; `cdp-eval` reports that and exits rather
   than hanging. Re-run against the recreated view, or set the delay to `0` for the profile
   under test while you work.

3. **Hot-swap rules in `/tmp/magimail-gmail.css`**:
   Save edits directly to `/tmp/magimail-gmail.css`. Magimail automatically re-injects on
   save without restarting the app.
4. **Verify the change**:
   Re-run `cdp-eval.mjs` to confirm the updated computed style or capture a new screenshot.
5. **Persist the fix**:
   Once verified on the live page, port the winning rules back into `apps/magimail/src/css.ts`.

## Reading the logs

`~/Library/Logs/Magimail/main.log` and `~/Library/Logs/Magical/main.log` hold `info` and
above, opening with a startup banner that names the app, Electron, Chromium, Node and the
macOS version. Swift helper diagnostics are folded in from stderr, so one file covers Main
and the helper together.

```bash
tail -f ~/Library/Logs/Magimail/main.log

# Live, across every native surface including the sandboxed extensions.
# Spell out /usr/bin/log: zsh has a `log` builtin that shadows it, and the
# bare command fails with "too many arguments" rather than anything useful.
/usr/bin/log stream --predicate 'subsystem == "com.alexhaslam.magimail"'
```

Extension logs are written into the App Group container, not into `~/Library/Logs`. Main
copies them across on startup, on a deep link, and whenever **Help → Reveal Logs in Finder**
is used; `share-extension.log`, `widgets-extension.log` and `app-intents-extension.log` then
sit beside `main.log`. Reveal the logs before reading them, or you are reading a stale copy.

The addon is the blind spot. It runs inside Electron Main with no pipe to tap and logs
nothing by design, so a toolbar defect is diagnosed by reading `magimail_addon.mm` and by
what Main logged either side of the call. Do not add a file-writing debug hook; one shipped
in a signed bundle once, writing to world-readable `/tmp`.

Magical has no equivalent launcher. Debug it with `npx electron .` from `apps/magical` and
its own log file — but not against the real profile. An unpackaged build cannot get the key the
installed app's partition cookies are sealed with, and Chromium drops the rows it cannot read, so the
run signs every account out. Point it at a throwaway profile, or debug the installed app and accept
that the code under test is the build in `/Applications`.
