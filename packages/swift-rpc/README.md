# `HelperRPC`

The newline-delimited JSON-RPC transport that Magimail's and Magical's Swift helpers
both speak to their Electron main process. Two files, no app-specific content:

- `Protocol.swift` — `RPCRequest`, `RPCResponse`, `RPCEvent` and the `AnyCodable` used
  to carry arbitrary JSON payloads.
- `StdioTransport.swift` — reads lines from `stdin` on a background thread, dispatches
  them to the main actor, writes replies and events to `stdout`.

Both were byte-identical copies in the two apps before this package existed.

## Using it

SwiftPM path dependency, from an app's `swift/Package.swift`:

```swift
.package(path: "../../../packages/swift-rpc")
```

then `import HelperRPC` in any file that names `StdioTransport` or `RPCRequest`. There
is no re-export from the app's own library target, deliberately — `@_exported` is an
underscored attribute, and an explicit import in the handful of files that need one is
cheaper than depending on it.

## What does not belong here

Anything that knows what the messages _mean_. The method names, the settings model, the
windows and the menu bar all stay in their app's own helper — this package knows only
how to get a JSON object from one process to the other.

It is not a node package and has no `package.json`, so pnpm's `packages/*` workspace
glob skips it.
