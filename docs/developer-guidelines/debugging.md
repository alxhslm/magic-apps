# Debugging the Gmail UI

Most Magimail UI defects are questions about what the injected CSS did to Gmail's DOM: which rule
matched, what the computed style ended up as, why an icon is invisible or the wrong colour. Reading
`apps/magimail/src/css.ts` cannot answer those, because the answer depends on Gmail's live markup.
Attach to a running app and ask the page.

## Attach with one command

```bash
pnpm run magimail:debug            # dark-mode CSS, CDP on port 9222
pnpm run magimail:debug --light    # light-mode CSS
pnpm run magimail:debug --port 9223
```

This dumps the stylesheet Magimail would inject to a file, relaunches `/Applications/Magimail.app`
with `--debug-port` and `--css-override` pointed at it, waits until the Gmail page target is
attachable, and prints the endpoint and the CSS path.

It relaunches, so a running Magimail is quit first. It is the user's mail client, so tell them before
running it. The installed app is what launches; to debug a development build instead, run
`npx electron .` from `apps/magimail` with the same two flags.

Add `--demo` to either (`pnpm run magimail:dev:demo`, or `npx electron . --demo`) to run against the
isolated `Magimail-demo` profile. Without it a development build opens the live userData directory,
and if the installed app is also running the two share one Chromium profile and one cookie-encryption
keychain item, which is unsupported and can rewrite the cookie stores and sign the user out. See
[`scripts.md`'s Demo profiles](scripts.md#demo-profiles).

## Edit the injected CSS without rebuilding

Magimail injects with `cssOrigin: 'user'`, which is what lets its rules beat Gmail's author-origin
`!important`. The cost is that the winning stylesheet is invisible to a debugger: Chromium does not
expose user-origin sheets over CDP, `CSS.getAllStyleSheets` will not list it, and writing to the
page's own `<style id="magimail-injected-styles">` element has no effect against it.

`--css-override=<path>` is the way in. It replaces the composed stylesheet with a file's contents and
re-injects on every save, so iterating on a selector is a save rather than a rebuild and relaunch:

```bash
# Dump the real stylesheet, then edit it live against the running app
pnpm --filter magimail run dump:css -- --dark -o /tmp/gmail.css
```

Re-run the dump after changing `apps/magimail/src/css.ts`, having rebuilt Magimail
(`pnpm --filter magimail run build`); the dump reads from `dist`, not `src`. Changes proven in the
override file still have to be written back into `css.ts`; the override is a scratchpad, not a
source.

## Query the page

Anything Chromium knows is one `Runtime.evaluate` away over the endpoint printed above. The useful
questions are almost always about computed style rather than about which rule was authored:

```js
// Which images escaped the dark-mode counter-invert?
[...document.querySelectorAll('img')]
  .filter((i) => getComputedStyle(i).filter === 'none')
  .map((i) => i.src);
```

Two habits worth keeping:

- **Count, do not spot-check.** "103 of 112 images are exempt" localises a bug in one query; looking
  at three elements does not.
- **Verify a fix on the live page, not only in tests.** A CSS assertion proves the string was
  written, not that the cascade resolved the way it was meant to. See
  [`../shared/design.md`](../shared/design.md) and [`../magimail/dark-mode.md`](../magimail/dark-mode.md).

## Run from a fresh worktree

A worktree cannot launch until the native artefacts exist, and the failure does not name its cause:
an unhandled `Not found: tried …` rejection from `attachNativeToolbar` aborts account
initialisation, so the window opens with no Gmail view and no CDP page target ever appears.

```bash
pnpm install
pnpm --filter @magimail/core run build   # else: "Cannot find module '@magimail/core'"
pnpm --filter magimail run build:native  # N-API addon and libMagimailNative.dylib
```

`build:native` is the slow one. Copying
`apps/magimail/native/build/Release/magimail_addon.node` and
`apps/magimail/native/.build/release/libMagimailNative.dylib` from another worktree on the same
machine works and takes a second.
