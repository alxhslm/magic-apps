# Testing

## Unit tests

TypeScript tests run with **Vitest**; the Swift helpers and the RPC transport run with **SwiftPM
(`swift test`)**.

- Tests never make real network calls or start a Google login flow.
- Mock Electron APIs (`session`, `webContents`, `BrowserWindow`, `nativeTheme`) with Vitest test
  doubles.
- Run these before opening a pull request:

```bash
pnpm run test
pnpm run typecheck
(cd packages/swift-rpc && swift test)
(cd packages/swift-brand && swift test)
(cd packages/swift-ui && swift test)
(cd apps/magical/swift && swift test)
(cd apps/magimail/swift && swift test)
```

## Native views

A change to a view the helpers draw — the popover, a widget header, the settings window — is checked
by rendering it, not by launching the app. `tools/shots` builds the real `MagicalHelperLib` and
`MagimailHelperLib` views into an `NSHostingView`, draws them with `cacheDisplay` and writes a PNG
per composition:

```bash
swift run --package-path tools/shots shots /tmp/shots-after
```

It takes the output directory as its only argument, so the same command run before and after a change
gives two sets of images to compare, and `magick compare -metric AE` or a plain hash says whether a
surface moved. Freeze `now` in `tools/shots/Sources/shots/main.swift` first: the fixtures and the
relative-time labels are built against the wall clock, so otherwise they redraw differently between
the two runs and the difference you are looking for is one region among many.

## Pre-commit hooks

Husky and `lint-staged` run on every `git commit`:

- `eslint --fix` and `prettier --write` on staged TypeScript and JavaScript.
- `prettier --write` on JSON, Markdown and CSS.
- `swiftformat` on staged Swift files.
