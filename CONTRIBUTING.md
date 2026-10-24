# Contributing to Magic Apps

Thanks for your interest in Magic Apps.

Magic Apps is an open-source project building high-performance, native macOS desktop applications for Google Workspace:

- **Magimail** (`apps/magimail`): the native macOS client for Gmail. It provides AppKit vibrancy, multi-account session isolation, a native `NSToolbar`, SwiftUI settings, Gmail Atom notifications, and WidgetKit/Share Sheet extensions.
- **Magical** (`apps/magical`): the native menu bar and desktop client for Google Calendar, with multi-account session isolation, a menu bar popover, desktop widgets, Focus filters and a live `NSDockTile` date.
- **Core Engine** (`packages/core`): the shared engine. It provides session partition isolation, themes, a consistent browser identity, and IPC constants.

Anyone is welcome to inspect, compile, run and modify the code.

## 🛠️ System Requirements & Prerequisites

To build and run the apps from source, your machine needs:

| Tool            | Required Version            | Notes                                                                                                                                   |
| :-------------- | :-------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS**       | `>= 14.0` (Sonoma or later) | Target architecture: Apple Silicon (`arm64`)                                                                                            |
| **Node.js**     | `>= 20.0.0`                 | Node runtime for build tooling and Electron host                                                                                        |
| **pnpm**        | `>= 9.0.0`                  | Monorepo package manager (`pnpm -v`)                                                                                                    |
| **Xcode / CLT** | Installed                   | CLT (`xcode-select --install`) provides `clang++` and `swift` for dev; full Xcode is required for `.app` bundle builds (app extensions) |
| **swiftformat** | Latest                      | `brew install swiftformat` (formats Swift code)                                                                                         |

## 🚀 Quick Start: Building & Running Locally

### 1. Clone the Repository

```bash
git clone https://github.com/alxhslm/magic-apps.git
cd magic-apps
```

### 2. Install Workspace Dependencies

```bash
pnpm install
```

### 3. Build the Native Swift Helper

The Swift helper executable (`MagimailHelper`) provides the native SwiftUI Settings window, menu bar item (`NSStatusItem`), notifications, and WidgetKit integration:

```bash
pnpm --filter magimail run build:swift
```

> **Note**: Always use `pnpm --filter magimail run build:swift` (or `apps/magimail/swift/build.sh`) rather than bare `swift build`, as it correctly codesigns the binary to allow local macOS notification registration.

### 4. Launch in Development Mode

```bash
pnpm run dev
```

This compiles `@magimail/core`, watches TypeScript sources, and launches Magimail with Electron.

## 📦 Compiling a Complete Standalone App (`.app`)

To compile all six native targets (Electron host, C++ N-API addon, Swift helper, Share extension, WidgetKit extension, and App Intents extension) and assemble a runnable bundle:

```bash
# Build the complete Magimail.app bundle
pnpm run magimail

# Or build and automatically install into /Applications/Magimail.app:
pnpm run magimail:install
```

`scripts/build-app.sh` asserts that every native subsystem compiled successfully before assembling the bundle.

Packaging a full `.app` also needs a signing certificate. Any kind works, and a free Apple ID is enough: in Xcode, **Settings → Accounts → Manage Certificates… → + → Apple Development**. Generate it on the machine you build on, so the private key stays local, and check what you have with `security find-identity -v -p codesigning`. `pnpm run dev`, which covers most TypeScript work, needs no certificate at all.

## 🏛️ Repository rules

The project stays narrow: Gmail and Google Calendar, nothing else. It does not support another mail or calendar provider, and it does not change Google's interface. The apps do not aim to add functionality, only to integrate Google's web app into macOS. A feature that does not serve one of the two apps belongs in its own project.

Before proposing a feature, check [GitHub Issues](https://github.com/alxhslm/magic-apps/issues) and
[GitHub Milestones](https://github.com/alxhslm/magic-apps/milestones). A spec is a design, not an
implementation.

Before opening a pull request:

1. **Respect the monorepo boundary.** Code both apps need lives in `packages/core`; DOM manipulation and window lifecycles stay in `apps/`. See [`docs/developer-guidelines/coding-standards.md`](docs/developer-guidelines/coding-standards.md).
2. **Use real native controls.** Use AppKit and SwiftUI controls, laid out per Apple's Human Interface Guidelines, so each macOS version draws its own chrome. See [`docs/shared/design.md`](docs/shared/design.md).
3. **Select Google's DOM semantically.** Target ARIA roles and standard attributes, never the minified class names Google ships. See [`docs/magimail/overview.md`](docs/magimail/overview.md).
4. **Present Google's UI as it is.** The apps wrap Gmail and Calendar rather than redesigning them. The injected layer may invert the page for dark mode, make the body transparent for vibrancy, or hide chrome the user asked to hide, and nothing else. See [`docs/shared/design.md`](docs/shared/design.md).
5. **Encrypt user data at rest.** Account, settings and cache files go through `secret-file.ts`, which is AES-256-GCM under a Keychain key, and Chromium's cookie encryption stays on. See [`docs/shared/sessions-and-security.md`](docs/shared/sessions-and-security.md).
6. **Keep it direct and private.** The apps talk straight to Google over HTTPS, with no intermediate servers, analytics or telemetry. See [`docs/shared/sessions-and-security.md`](docs/shared/sessions-and-security.md).
7. **Write a unit test for what you change.** `pnpm run test` covers every package and must pass before a pull request. See [`docs/developer-guidelines/coding-standards.md`](docs/developer-guidelines/coding-standards.md).
8. **Keep docs up to date.** A change updates the document it invalidates in the same pull request. See [`docs/README.md`](docs/README.md).

## 🧪 Testing & Code Quality

Run the tests and verification commands before you commit:

```bash
# Run unit tests across all packages
pnpm run test

# Verify TypeScript type checks
pnpm run typecheck

# Check code formatting & linting
pnpm run lint
pnpm run format:check
```

Pre-commit hooks automatically format staged Swift files with `swiftformat` and TypeScript/Markdown with `prettier`.

## 🐛 Submitting Issues & Pull Requests

### Reporting Bugs

- Check existing [GitHub Issues](https://github.com/alxhslm/magic-apps/issues) first; your bug may already be reported.
- Open a new issue with the **Bug Report template** and include:
  - macOS version (e.g. Sonoma 14.5, Sequoia 15.0)
  - Apple Silicon chip model (M1, M2, M3, M4, etc.)
  - Clear steps to reproduce
  - A screenshot or screen recording that shows the problem
  - Console or diagnostic logs (Help → Reveal Log…)

### Pull Request Workflow

1. Create a branch following our naming convention:
   - `fix/<issue-number>-<short-slug>` (e.g. `fix/42-category-selector`)
   - `feat/<issue-number>-<short-slug>` (e.g. `feat/12-calendar-shortcut`)
2. Make your changes and add tests where appropriate.
3. Ensure `pnpm run test` and `pnpm run typecheck` pass cleanly.
4. For a change to a window, toolbar, popover, notification or widget, include a screenshot in the pull request so a reviewer can see it without building. See [`capturing-website-shots`](.agents/skills/capturing-website-shots/SKILL.md).
5. Open a Pull Request referencing the issue: `Closes #<issue-number>`.
6. Document any architectural change or new feature in the matching document in `docs/`.

### Licensing and Contributor Agreement

By submitting a pull request or contributing code, documentation, or assets to Magic Apps, you agree to the following terms:

1. **Open Source Grant**: Your contribution is licensed to the public under the [Mozilla Public License 2.0](LICENSE).
2. **Commercial & Distribution Grant**: You grant Alex Haslam a perpetual, worldwide, non-exclusive, royalty-free, transferable, and sublicensable license to use, reproduce, modify, display, package, distribute, and sell your contribution, in source or binary form, as part of official Magic Apps releases, commercial packages, app store distributions (including the Apple Mac App Store), or future dual-licensed/commercial editions of the software, without restriction or accounting.
3. **Originality & Authority**: You represent that the contribution is your original work, that you hold the legal right to grant these rights, and that your contribution does not violate any third-party intellectual property, patent, or confidentiality rights.
4. **Attribution**: Alex Haslam agrees to preserve your copyright attribution in the repository's git commit history.

For more details on how licensing is structured, see [`docs/shared/licensing.md`](docs/shared/licensing.md).
