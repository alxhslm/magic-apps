# Setup

Building compiles TypeScript, a C++ N-API addon and Swift SPM packages, so you need all of the
following:

| Tool                           | Requirement                                     | Purpose                                                                                                                                                      |
| :----------------------------- | :---------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS**                      | 14.0 or later, Apple silicon or Intel           | Both Swift packages declare `.macOS(.v14)` and the bundle sets `LSMinimumSystemVersion 14.0.0`.                                                              |
| **Node.js**                    | 22                                              | Runtime for build tools and the Electron host.                                                                                                               |
| **pnpm**                       | 11, the version in `packageManager` (`11.24.0`) | Workspace package manager.                                                                                                                                   |
| **Xcode / Command Line Tools** | CLT via `xcode-select --install`, or Xcode      | CLT provides `clang++` and `swift` for `pnpm run dev` and the Swift helpers; the `.app` bundle's Share and widget extensions need full Xcode (`xcodebuild`). |
| **swiftformat**                | `brew install swiftformat`                      | Pre-commit hooks run it on every `*.swift` file.                                                                                                             |

## First run

```bash
git clone git@github.com:alxhslm/magic-apps.git
cd magic-apps
pnpm install
```

## Run in development mode

```bash
pnpm run dev
```

This builds `@magimail/core` and boots Magimail with Electron. It builds no native artefact, so
notifications and widgets are unavailable; see [Build the Swift helper](#build-the-swift-helper).

## Build the Swift helper

The helper executable is `MagimailHelper`, the child process behind the Settings window, the menu bar
item and notifications:

```bash
pnpm --filter magimail run build:swift
# or: cd apps/magimail/swift && ./build.sh release
```

Use the script rather than a bare `swift build`. It signs the binary as the app, and an unsigned
helper cannot post notifications. Banners and widget reloads also need an installed bundle, so under
`pnpm run dev` both are skipped. See [`../magimail/notifications.md`](../magimail/notifications.md).
