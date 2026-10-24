---
paths:
  - 'apps/**/*.swift'
  - 'apps/**/native/**'
  - 'apps/*/scripts/build-app.sh'
  - 'apps/**/electron-builder.json'
  - 'apps/**/*.plist.in'
  - 'packages/swift-rpc/**'
  - 'packages/swift-native/**'
  - 'tools/signing.sh'
---

Everything outside the Google web view is a real macOS control, and a mistake here fails at runtime
rather than at build time. Read
[`design.md`'s native-UI principles](../../docs/shared/design.md#looking-like-first-party-macos-software)
and [`building-and-signing.md`](../../docs/shared/building-and-signing.md) before changing native code.

- **Let the OS draw itself.** Prefer native AppKit and SwiftUI controls, so each macOS release
  renders its own style. A hand-rolled lookalike owns every appearance the system can be in and is
  wrong on at least one of them.
- **Sign each native artefact with the app's identity and ship it where macOS looks.** The helper
  takes `Contents/MacOS` so it inherits the app's bundle identity; an `.appex` outside
  `Contents/PlugIns` is invisible to the gallery. electron-builder re-signs `Contents/Extensions`
  with `inherit`, which strips the sandbox, so the App Intents appex stays in `signIgnore`.
- **Build through the scripts**, `pnpm --filter <app> run build:swift` and each extension's `build.sh`,
  never a bare `swift build`; an unsigned helper breaks notifications.
- **Verify native changes at the process boundary.** A unit test does not reach across it; use the
  `testing-native-subsystems` skill.
