# CI

The checks that gate a merge.

All CI workflows run on GitHub-hosted runners (`ubuntu-latest` and `macos-latest`).

## The workflows

`ci.yml` runs lint, typecheck, tests, dependency vulnerability audits and bundle-size checks on
GitHub-hosted Ubuntu runners, and the Swift checks (`check-swift`) on GitHub-hosted macOS (`macos-latest`).
`build.yml` packages the unpacked bundle on every push to `main` for whichever apps changed; it
answers whether the native targets still assemble and package cleanly with `--adhoc`, and publishes
nothing.

## Dependency security

Both apps hold live Google session cookies in the main process, so a compromised production
dependency exposes every account's session.

- **Vulnerability audit in CI**: `ci.yml` audits production dependencies with
  `pnpm audit --prod --audit-level high`. A known high or critical advisory in the production tree
  fails the build. Advisories in development dependencies are reported in the step log for
  visibility, but do not block the build.
- **Dependabot**: `.github/dependabot.yml` checks for updates weekly across `pnpm` packages and
  GitHub Actions, raising pull requests with `chore(deps)` and `chore(ci)` commit prefixes.

`build.yml` resolves the list of apps before the matrix rather than by skipping steps inside it. A
matrix leg that skips every step still reports a green check nobody ran, which reads as "Magical
packaged fine" when Magical was never touched. A change under `packages/**` or `tools/**` rebuilds
both apps, because it lands in both bundles.
