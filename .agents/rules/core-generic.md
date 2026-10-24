---
paths:
  - 'packages/core/**'
---

`packages/core` is shared by both apps and runs outside Electron, so keep it generic. Read
[`design.md`](../../docs/shared/design.md) and [`logging.md`](../../docs/shared/logging.md) before
adding to it.

- **Nothing app-specific.** Gmail DOM, Calendar wiring, window lifecycles and native supervisor
  logic belong in `apps/`; core holds only what both apps use unchanged.
- **Core runs in plain Node and in preloads, so it cannot import Electron.** Where a module needs to
  log, take an injected `LogSink`; the `logging` rule covers the call-site rules.
- **Browser identity is defined once, in `@magimail/core`.** Both apps use it rather than redefining a
  User-Agent or a brand list of their own. It is derived from `process.versions.chrome`, because a
  pinned string once sent Chrome 132 headers while running Chromium 152.
- **A function shipped to a page is serialised.** `applyMainWorldIdentity` reaches the main world
  through `contextBridge.executeInMainWorld`, so it may not reference imports or module constants;
  pass data as arguments. A test asserts this.
- **Structured data is validated against a schema, and the type is inferred from it.** zod is the
  default, so the rule is written once and the validator cannot drift from the TypeScript type.
  `dom-labels.ts` is the worked example; `coding-standards.md` names zod in the stack.
