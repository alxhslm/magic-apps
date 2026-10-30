# Memory and Chromium tuning

A second hot account costs about 450 MB, and the only way not to pay it is to unload the account:
[What actually reclaims renderer memory (measured)](#what-actually-reclaims-renderer-memory-measured)
records the measurement showing that no in-place technique reclaims a single megabyte from a live
renderer. Accounts the user is switching between stay hot for a configurable grace period (Settings →
Advanced → Memory). Accounts left alone are released, and reload where they left off.

## Where the 2 GB goes

An unconfigured Electron application wrapping Google Workspace uses **1.5 GB – 2.0 GB of RAM**. Five
redundancies in unconfigured Chromium account for it:

| #   | Redundancy in unconfigured Chromium  | Cost                 |
| :-- | :----------------------------------- | :------------------- |
| 1   | Phantom `BrowserWindow` renderer     | ~100 MB              |
| 2   | Dedicated `dragView` WebContentsView | ~100 MB              |
| 3   | Unbounded V8 JavaScript heap         | ~500 MB per account  |
| 4   | Full Chrome background subsystems    | ~350 MB (GPU / util) |
| 5   | Heavy background sync (IMAP + REST)  | ~100 MB of buffers   |

|                        | Footprint         |
| :--------------------- | :---------------- |
| **Total, unoptimised** | ~1.55 GB – 2.0 GB |
| **Optimised target**   | ~320 MB – 380 MB  |

## Eliminate the phantom renderer

`new BrowserWindow({ ... })` creates a hidden default web page, and with it a full Chromium renderer
process, GPU context and V8 heap (~100MB RAM), even when a `WebContentsView` covers the window
completely. `BaseWindow` (`import { BaseWindow } from 'electron'`) is a native AppKit/Cocoa window
container built to host `WebContentsView`s, and it starts no web engine of its own:

```ts
// packages/core/src/window.ts: options only. Core imports *types* from electron
// and never the runtime, so the window is constructed in the app, not here.
import type { BaseWindowConstructorOptions } from 'electron';

export function createMainWindow(options?: BaseWindowConstructorOptions): BaseWindow {
  return new BaseWindow({
    width: 1280,
    height: 850,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    ...options,
  });
}
```

This saves **~100 MB**.

## Remove extra `dragView` WebContents processes

A separate `WebContentsView` hosting nothing but an empty
`<style>body{-webkit-app-region:drag}</style>` page spawns a whole 64-bit Chromium renderer process
and GPU compositing layer, all for an invisible 38px drag rectangle. It measured **79 MB RSS** on a
running two-account install.

`AccountsManager` therefore keeps no `dragView`. The `NSToolbar` that `attachNativeToolbar` installs
sits above it in the native view hierarchy and takes the titlebar's mouse events itself, so the drag
region never receives them; AppKit already drags the window from the toolbar's empty space. This saves
**~79 MB**.

## Disabling unused Chromium browser subsystems

Chromium starts dozens of background services meant for a general web browser: translation
dictionaries, autofill cloud sync, media session monitoring, speculative DNS prefetching. A dedicated
desktop client uses none of them. Apply these switches in the main process, in
`packages/core/src/session.ts` or `apps/magimail/src/main.ts`, before `app.whenReady()`:

```ts
// packages/core/src/performance.ts
import { app } from 'electron';

export function applyChromiumPerformanceSwitches(): void {
  // 1. Disable Chrome background networking (speculative prefetching, telemetry)
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-component-update');

  // 2. Disable unused Chrome extensions & app subsystems
  app.commandLine.appendSwitch('disable-default-apps');
  app.commandLine.appendSwitch('disable-extensions');

  // 3. Disable heavy unused Chromium background services
  app.commandLine.appendSwitch(
    'disable-features',
    [
      'AutofillServerCommunication',
      'CalculateNativeWinOcclusion',
      'InterestFeedContentSuggestions',
      'MediaSessionService',
      'HardwareMediaKeyHandling',
      'Translate',
      'CertificateTransparencyComponentUpdater',
    ].join(','),
  );

  // 4. Shrink GPU process memory buffers (Drops GPU helper from ~350MB to ~70MB)
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
}
```

This saves **~250 MB – 300 MB across GPU and utility helper processes.**

## V8 heap tuning: shrinking Gmail without reloading

On 64-bit macOS, V8 defaults to a 2GB–4GB memory ceiling. Opening emails, reading threads and
searching creates thousands of JavaScript objects and DOM nodes. V8 leaves the dead ones sitting in
memory rather than running a mark-sweep collection, because it can see the Mac has RAM to spare.

### V8 capping switch

```ts
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');
```

This tells V8 to collect unreferenced JavaScript objects as soon as Gmail finishes rendering an inbox
or a search query, instead of letting them accumulate. The Gmail tab stays loaded; nothing reloads.

The measured effect on RSS is small. With `--max-old-space-size=256` in force, the two Gmail renderers
on a running install measured **502 MB and 414 MB RSS**. Capping old-space bounds how far the heap can
grow. It does not shrink the DOM, the compositor tiles, or the resident pages Chromium has already
faulted in.

## What actually reclaims renderer memory (measured)

Do not spend effort on freezing, throttling, or purging in the hope of getting RAM back. Every
in-place technique was measured against a live 188 MB renderer under Electron 44 and reclaimed
**nothing**:

| Technique                                   | RSS reclaimed |
| :------------------------------------------ | :------------ |
| `contentView.removeChildView(view)`         | 0 MB          |
| `webContents.setBackgroundThrottling(true)` | 0 MB          |
| CDP `Page.setWebLifecycleState('frozen')`   | 0 MB          |
| CDP `HeapProfiler.collectGarbage`           | 0 MB          |
| CDP `Memory.forciblyPurgeJavaScriptMemory`  | 0 MB          |
| `loadURL('about:blank')`                    | 0 MB          |
| **`webContents.close()`**                   | **all of it** |

A renderer process does not return its faulted-in pages to the OS, even with an empty heap and no
document. Throttle and freeze for CPU and battery; that is all they are worth. Destroying the
`WebContents` is the only thing that gives memory back, so both apps remove an idle account from
memory rather than slimming it ([`window-lifecycle.md`'s Account renderer lifetime](window-lifecycle.md#account-renderer-lifetime)).

Two corollaries:

- **Constructing a `WebContentsView` costs almost nothing; navigating it is what costs.** Three views
  constructed with a preload and a partition but never navigated added no renderer processes at all,
  and ~7 MB each of main-process bookkeeping. The renderer spawns on first navigation, so deferring
  `loadURL` is what saves memory. Deferring construction is only tidiness.
- **Suspension is invisible to notifications.** `session.fromPartition(...).fetch()` on a partition
  with zero `WebContentsView`s returns 200; see
  [Notification sync architecture](#notification-sync-architecture-partition-authenticated-atom-feed-vs-heavy-imaprest).

## Notification sync architecture: partition-authenticated Atom feed vs. heavy IMAP/REST

Magimail polls Gmail's partition-authenticated Atom XML feed rather than holding IMAP IDLE sockets
open or polling the OAuth REST API. The feed delivers notifications without keeping a connection open,
and without spending memory or CPU on a background sync.

| Concern                | How the partition-authenticated feed handles it                       |
| :--------------------- | :-------------------------------------------------------------------- |
| Persistent connections | None. No sockets and no TLS buffers to hold open (~0 MB)              |
| Request size           | A direct HTTP fetch via `ses.fetch()`, under 10 KB of XML             |
| Authentication         | The partition's existing session cookies: nothing to store or refresh |
| Approvals              | No CASA Tier-2 audit, no GCP project, no OAuth scope                  |

When it polls:

| State        | Interval                                                                               |
| :----------- | :------------------------------------------------------------------------------------- |
| AC power     | 60 s by default, configurable as `pollIntervalSeconds`                                 |
| Battery      | 180 s by default (`pollIntervalBatterySeconds`), via `powerMonitor.isOnBatteryPower()` |
| Window focus | 5 s on AC, 8 s on battery for the focused account (`atom-poller.ts`)                   |
| Suspended    | Paused on suspend, with an immediate fetch on resume                                   |

The poller is decoupled from the renderers. Polling runs directly in the Node.js main process using
`ses.fetch()` bound to each account's `persist:magimail_*` session, so account `WebContentsView`
instances can be unloaded in the background without interrupting badge count updates or notification
delivery. Verified directly: `session.fromPartition(p).fetch()` on a partition that has never had a
`WebContentsView` returns 200, because the cookies live in the partition on disk, not in the renderer.
This is what makes lazy loading and suspension safe.

A suspended account loses one thing, the renderer-side mailbox-change hint
(`IPC_CHANNELS.MAILBOX_CHANGE_HINT`). That hint is only a _trigger_ for an earlier poll, and the feed
response remains the sole source of the count. It only ever mattered for the mailbox on screen, so
inactive accounts are throttled rather than kept awake to send it.

Idempotent HTTP requests replace the TLS socket lifecycle that `imapflow` needed. A transient network
failure, or a 401 on an unauthenticated session, backs off gracefully; no runaway reconnection task is
ever spawned.

## Memory matrix

Measured with `ps -Ao rss` on a running two-account install, both accounts signed in, rather than
projected. "Idle" is after the inactive account has aged out (see
[What actually reclaims renderer memory (measured)](#what-actually-reclaims-renderer-memory-measured)).

| Process / Component             | Unoptimised  | Idle                                                                                                              |
| :------------------------------ | :----------- | :---------------------------------------------------------------------------------------------------------------- |
| Main (Browser)                  | 231 MB       | 231 MB                                                                                                            |
| GPU helper                      | 100 MB       | 100 MB                                                                                                            |
| NetworkService                  | 55 MB        | 55 MB                                                                                                             |
| Swift helper (`MagimailHelper`) | 71 MB        | 71 MB                                                                                                             |
| audio utility                   | 30 MB        | 30 MB                                                                                                             |
| video_capture utility           | 40 MB        | 40 MB                                                                                                             |
| `dragView` renderer             | 79 MB        | **0 MB** (removed, [Remove extra `dragView` WebContents processes](#remove-extra-dragview-webcontents-processes)) |
| Gmail renderer, active          | 502 MB       | ~500 MB                                                                                                           |
| Gmail renderer, inactive        | 414 MB       | **0 MB** (unloaded)                                                                                               |
| **TOTAL**                       | **~1.52 GB** | **~1.03 GB**                                                                                                      |

With the window hidden (tray-only), the active account ages out too and the total falls to **~530
MB**: no Gmail renderers at all, with badges and notifications still arriving from the main-process
Atom pollers.

### Remaining opportunities

- **One Gmail renderer at ~500 MB is the largest single cost.** V8 capping is already in force
  ([The V8 capping switch](#v8-capping-switch)). What is left is DOM, compositor tiles and shared
  libraries.
- **The audio and video_capture utilities cost 70 MB combined**, and a mail client uses neither.
  Chromium switches are the thing to try.
- **The Swift helper at 71 MB** is large for a tray, settings window, and notification router.
