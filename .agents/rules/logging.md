---
paths:
  - 'packages/core/src/logger.ts'
  - 'apps/**/src/extension-logs.ts'
  - 'packages/swift-rpc/**'
  - 'apps/**/swift/**'
  - 'packages/core/tests/redact.test.ts'
---

The log is written to be attached to a bug report, so it leaves the machine. Read
[`logging.md`](../../docs/shared/logging.md) before adding a call site.

- **Nothing that identifies a person, or the content of their mail, may be in a line.** Redact at the
  call site with `redactUrl`, and lean on the transport transform for addresses and home paths;
  either layer alone fails open.
- **Do not over-redact.** Account index, partition name, error codes, HTTP statuses, counts and
  timings stay, because they are the diagnosis. The test for a field is whether it identifies a
  person or their mail.
- **Import the logger from `@magimail/core/logger`, never the barrel.** The barrel pulls in Electron
  and fails in plain Node. Code inside `packages/core` takes an injected `LogSink` instead.
- **The Swift side logs four ways.** The helper writes `LEVEL|Category|message` to stderr through
  `HelperLog`; the N-API addon writes OSLog; the appexes write an App Group file that Main folds in;
  `packages/swift-native` logs nothing. A bare `print()` in a helper corrupts the JSON-RPC pipe.
- **Mark dynamic OSLog values `.public`,** or the system log shows `<private>` where the value should
  be.

`packages/core/tests/redact.test.ts` is the test that must never regress. Everything else in the
logger can break and produce a bad log; a regression there produces a leaked one.
