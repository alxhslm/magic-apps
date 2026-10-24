---
paths:
  - 'apps/magimail/src/main.ts'
  - 'apps/magimail/src/window.ts'
  - 'apps/magimail/src/accounts-manager.ts'
  - 'apps/magimail/src/swift-helper.ts'
  - 'apps/magical/src/main.ts'
  - 'apps/magical/src/accounts-manager.ts'
  - 'apps/magical/src/swift-helper.ts'
---

- **The main window is a `BaseWindow`, never a `BrowserWindow`.** A `BrowserWindow` starts a hidden
  renderer even when a `WebContentsView` covers it. See
  [`performance-optimisation.md`](../../docs/shared/performance-optimisation.md#eliminate-the-phantom-renderer).
- **Fetch background data through the account's session, never `net.fetch` or the global `fetch`.**
  See the `sessions-security` rule for why.
- **The Swift helper is a long-lived child process speaking newline-delimited JSON-RPC** over
  `stdin`/`stdout`. See [`process-model-and-ipc.md`](../../docs/shared/process-model-and-ipc.md).
- **Gate every development handle.** Anything put on `globalThis` for debugging sits behind
  `process.env.DEBUG` or a non-production check.
