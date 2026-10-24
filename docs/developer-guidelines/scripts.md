# Scripts

Run every workflow with `pnpm` from the workspace root:

| Command                      | Action                                                                                                                              |
| :--------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run dev`               | Starts Magimail in dev mode with live TypeScript watching, against the live profile.                                                |
| `pnpm run dev:demo`          | The same, against the isolated `Magimail-demo` profile: no real accounts, and no sharing a Chromium profile with the installed app. |
| `pnpm run magimail:dev:demo` | The same, in Magimail's own name.                                                                                                   |
| `pnpm run magical:dev:demo`  | Starts Magical in dev mode against the isolated `Magical-demo` profile.                                                             |
| `pnpm run build`             | Recursively builds `@magimail/core` and all app targets via `tsup`.                                                                 |
| `pnpm run test:e2e`          | CDP-driven end-to-end tests (`apps/magimail/tests/e2e/`) against the unpackaged Electron binary. See below.                         |
| `pnpm run test`              | Runs all Vitest unit tests across packages.                                                                                         |
| `pnpm run test:watch`        | Runs Vitest in interactive watch mode.                                                                                              |
| `pnpm run typecheck`         | Runs `tsc --noEmit` across all workspace packages.                                                                                  |
| `pnpm run lint`              | Runs ESLint 9 across TypeScript and JavaScript sources.                                                                             |
| `pnpm run lint:fix`          | Fixes ESLint issues.                                                                                                                |
| `pnpm run format`            | Runs Prettier across all markdown, JSON, CSS and TS files.                                                                          |
| `pnpm run format:check`      | Verifies Prettier compliance, used in CI.                                                                                           |
| `pnpm run audit`             | Audits production dependencies, failing on high or critical advisories.                                                             |
| `pnpm run audit:dev`         | Audits development dependencies for known advisories.                                                                               |
| `pnpm run magimail`          | Builds the complete `Magimail.app` bundle via `scripts/build-app.sh`, asserting every native artefact exists.                       |
| `pnpm run magimail:install`  | Same, then replaces `/Applications/Magimail.app`.                                                                                   |
| `pnpm run package:magimail`  | Packages an `arm64` `.dmg`. Prefer `pnpm run magimail`; this does not assert the native artefacts are present.                      |
| `pnpm run magimail:debug`    | Relaunches the installed app with a CDP port and a live-editable CSS override. See [`debugging.md`](debugging.md).                  |
| `pnpm run magical:debug`     | Relaunches the installed Magical with a CDP port. Add `--demo` for the isolated profile.                                            |
| `pnpm run release:magimail`  | Tags and publishes Magimail. Maintainer-only, and its procedure is not documented in this repository.                               |
| `pnpm run release:magical`   | The same for Magical, through `apps/magical/scripts/release.sh`.                                                                    |

### Demo profiles

`--demo` resolves userData to `<App>-demo` (`packages/core/src/user-data.ts`), keeps the run out of
the App Group, and runs under its own app name (`Magical-demo` / `Magimail-demo`), so Chromium
derives a distinct `<App>-demo Safe Storage` keychain item rather than sharing the real one. `dev:demo`
uses it for the unpackaged dev build; `magical:debug --demo` and `magimail:debug --demo` do the same
for the installed bundle. The log directory is pinned to the real app's, so the debugging skills keep
reading a single `main.log`.

Use it for any work that is not about your own mailbox or calendar. An unpackaged build with no
profile opens the **live** userData directory, and an unpackaged and an installed build then share
one Chromium profile and one cookie-encryption key; two Chromium instances on one profile is
unsupported and can rewrite the cookie stores, logging you out. The demo profile is the cheap way not
to be that accident.

### End-to-end tests

`pnpm run test:e2e` spawns the unpackaged Electron binary, so the run shares the default userData
directory with the installed app but not its identity. Credentials are encrypted under a keychain
item that belongs to the installed bundle, so an unpackaged run reads the account list from the
plaintext `accounts.json` and then loads Gmail signed out. No spec may depend on a signed-in session;
the compose pop-out path is covered by the unit tests for the window-open handler, `mailto-handler`
and `share-handler` instead. To exercise compose against a real session, drive the installed app with
a link: `open "mailto:someone@example.com?subject=Hello"`.
