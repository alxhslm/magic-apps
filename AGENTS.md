# Agent Guidelines

## Project Overview

**Magic Apps** is a high-performance native macOS project for Google Workspace:

- **`apps/magimail`**: Native macOS client for Gmail (AppKit vibrancy, multi-account session isolation, native `NSToolbar`, SwiftUI settings, Gmail Atom feed notifications, and Share Sheet and WidgetKit extensions).
- **`apps/magical`**: Native menu bar and desktop client for Google Calendar (natural language scheduling, global shortcuts).
- **`packages/core` (`@magimail/core`)**: Shared engine providing session partition isolation, themes, a consistent browser identity, and IPC constants.

## Documentation & Knowledge Base

Before designing or modifying code, read the authoritative documentation in `docs/`. The index is
[`docs/README.md`](docs/README.md); it lists every document and says where a change gets written
down.

**Add to this file only when the docs do not own it.** AGENTS.md is in context in every session, so
a fact repeated here is a second copy that drifts. Scope-specific guidance belongs in
`.agents/rules/`, a deep procedure in a skill, and the fact itself in `docs/`. A Magical spec is
rewritten into `docs/magical/` once the subsystem ships, and what is still unbuilt stays in
`specs/magical/`.

### Keeping documentation up to date

After making a change, review whether the docs for the parts you edited need updating, and fix them
in the same PR. [`docs/README.md`](docs/README.md) carries the full rules.

- **Changed how the code works?** Update the matching document. A module map, an IPC channel or a
  partition name that no longer matches is a defect in the doc, not a stale detail.
- **Changed how a subsystem is built, or ruled an approach out?** State a major decision and the
  constraint that settled it in the prose; that reasoning is the part no one can recover from the
  code. Do not keep a rejected-alternatives section.
- **Deleted code?** That counts too. Removing a feature, a setting or an IPC channel leaves prose
  that sends the next reader looking for something that is no longer there.

## Project Tools & Verification

- Package manager: `pnpm`
- Package runner: `npx`, `pnpm exec`
- GitHub operations: `gh` CLI
- Version control: `git`
- Unit testing: `pnpm run test` (`vitest`)
- Type checking: `pnpm run typecheck` (`tsc --noEmit`)
- Swift formatting: `swiftformat` (enforced on all `*.swift` files)
- Native Swift helper build: `pnpm --filter magimail run build:swift`
- Debugging a running build: `pnpm run magimail:debug`. Read [`debugging-the-app`](.agents/skills/debugging-the-app/SKILL.md) before diagnosing any defect in a running app; devtools on their own will mislead you.
- Full signed app build: `pnpm run magimail:install` (build all six targets, sign, replace `/Applications/Magimail.app`) or `pnpm run magimail` to build only

Never hand-assemble a bundle with `electron-builder` directly. It downgrades a missing `extraResources`/`extraFiles` entry to a _warning_, so a bundle without the Swift helper, native dylib, N-API addon, Share extension, Widget extension or App Intents extension packages happily and then launches with no toolbar, tray, settings window, notifications, widgets or Focus Filter. `scripts/build-app.sh` builds all six and refuses to package unless each artefact exists; see `docs/shared/building-and-signing.md`.

## Architectural Invariants

- **Monorepo Boundary**: `packages/core` must remain clean, reusable and free of DOM in the host processes that import it: nothing reachable from a main-process import may touch `document`, because that graph runs in Node. Window lifecycles, DOM injection, and native supervisor logic belong strictly in `apps/`.
- **Multi-Process Model**: Never assume Electron does everything. Both apps share one shape: Electron Main orchestrates; a Swift helper runs Settings, Tray and Notifications over newline-delimited JSON-RPC on `stdin`/`stdout`; a C++ N-API addon owns the Cocoa window and toolbar controls; and the Share, WidgetKit and App Intents extensions are OS-hosted `.appex` bundles reached only through files, distributed notifications and URL schemes. See `docs/shared/process-model-and-ipc.md`.
- **Minimum macOS 14 (Sonoma)**: Both Swift packages declare `.macOS(.v14)` and the bundle sets `LSMinimumSystemVersion 14.0.0`. Everything from Sonoma to Tahoe is supported, which is precisely why native controls are not optional; see below.

## Privacy

Real account, client, candidate and colleague data must never reach a tracked file or a commit message. Debugging runs against a live Google account, so a capture is full of it; redact as you capture, before a test or doc exists. The gate is `pnpm run privacy`, run by the husky `pre-commit` and `commit-msg` hooks against the gitignored `.sensitive-terms`. See [`.agents/rules/privacy.md`](.agents/rules/privacy.md) and the [`redacting-live-data`](.agents/skills/redacting-live-data/SKILL.md) skill.

## Workflow & Git

[`docs/developer-guidelines/workflow.md`](docs/developer-guidelines/workflow.md) carries how branches are named and how a pull request
closes its issue, along with the labels and milestones around them. What
follows is only the part that costs something to get wrong.

- **Check the base before you start.** `git fetch origin main`, then
  `git log --oneline HEAD..origin/main`. An empty answer is the only evidence that the
  work is against current code. Do it before diagnosing, measuring or reproducing
  anything, not only before branching: a measurement taken against stale code is not
  evidence about the code being shipped, and it is the cheapest mistake in this list
  to avoid. A latency investigation once ran four commits behind `main`, on a
  subsystem that had already been rewritten there, and every number in it was about
  the wrong build.
- Stage files by name. Never `git add -A` or `git add .`; unrelated work is often in
  progress alongside yours.
- Split the work into logical commits as you go: a refactor separate from the behaviour
  change that needed it, a test fix separate from the feature, a rename separate from
  anything else. Each message stands on its own.
- Merge `main` into the branch, pulling `main` first so it is up to date. Rebase onto it
  only while no pull request is open: rebasing a pushed branch means force-pushing it, and
  once a review is under way that rewrites what the review is built on.
- Never force push to a PR branch. Fix a pushed commit with a new commit on top.
- Resolving a review thread means resolving it, through `resolveReviewThread` in the
  GraphQL API; the REST endpoints do not cover it. A reply saying it has been addressed
  leaves the thread open.
