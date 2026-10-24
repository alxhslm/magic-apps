# Licensing

## The licence

Magic Apps is open-source software under the Mozilla Public License 2.0; the text is in
[`LICENSE`](../../LICENSE). Anyone may clone, inspect, compile, modify and redistribute it, including
commercially. Copyright 2026 Alex Haslam.

MPL 2.0 is file-level copyleft: a file you modify stays under MPL 2.0 and your modification has to be
published, but you may combine those files with files under other terms.

Pre-release builds require no paid license or key. Alex Haslam reserves the right to distribute official, notarized application packages and Mac App Store releases under separate commercial terms or offer paid editions in the future. The source code repository remains open source under MPL 2.0.

## Contributions

Contributions are governed by the Contributor Agreement in [`CONTRIBUTING.md`](../../CONTRIBUTING.md). Contributors license their work under MPL 2.0 to the community and simultaneously grant Alex Haslam a perpetual, worldwide, transferable license to include contributions in official commercial binaries and store releases.

## Packaged builds expire

Nothing has been released, so every packaged build carries a 90-day expiry stamped at compile
time. There is no updater, and without the expiry a build handed to someone works forever and
looks the same as a current one.

A stable release is exempt. It ships an updater, and the updater replaces a stale build, so the
expiry is redundant. Either an updater or an expiry, not both.

The predicate calls a version a pre-release when its major is 0 or it carries a semver pre-release tag
(`1.0.0-beta.1`, `1.2.0-rc.3`); build metadata does not count.

Each app's tsup config stamps the compile time into the main bundle as `__BUILD_TIMESTAMP__`. At
the top of `app.whenReady()`, before a window, helper or session exists, Main asks
`isPrereleaseBuildExpired()` whether the running build has passed its 90-day window. That predicate
is pure, and it lives in
[`packages/core/src/prerelease-build-expiry.ts`](../../packages/core/src/prerelease-build-expiry.ts).
A packaged build whose stamp is more than 90 days old gets a modal alert naming the compile date and
a link to `https://macmagic.app`, then quits.

A development run (`pnpm run dev`, `pnpm run start`, the E2E suite) is not a packaged build, and its
timestamp is rebuilt on every change.
