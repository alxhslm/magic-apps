---
paths:
  - '**/*.test.ts'
  - '**/*.test.tsx'
  - 'apps/**/tests/**'
  - 'packages/**/tests/**'
  - 'docs/**'
  - '.agents/**'
  - '**/fixtures/**'
  - 'README.md'
  - 'CONTRIBUTING.md'
  - 'SECURITY.md'
---

Real account data must never reach a tracked file. Debugging happens against a live Google account,
and the capture is full of client names, colleague and candidate addresses, real event summaries,
calendar ids and venues. The temptation is to paste those straight into a fixture, a doc example or
a commit message because they are the most recognisable strings in front of you. Do not.

## What counts as sensitive

- Client, employer, candidate and colleague names, including client product names.
- Any personal email address, or a hostname derived from one.
- Real Google calendar ids, series ids (`<id>_<UTC slot>`), `uid`s and Meet slugs.
- Real event summaries, venues, office buildings and locations.
- Anything copied from a live payload, `main.log`, a decrypted cache or a CDP capture.

Reserved and synthetic domains are fine: `example.com`, `example.org`, `work.com`,
`@group.calendar.google.com` and the like.

## How to work with a live capture

1. Write the capture outside the repo (`/tmp`). Never commit it.
2. Keep a real→placeholder table and substitute **as you capture**, before any test, doc or commit
   message is written.
3. Prefer obviously synthetic values: `example_series_id`, `Legacy stand-up`, `Example Room 4`.
4. Run the gate before committing: `pnpm run privacy`, or let the hooks do it.

## The gate

`tools/check-privacy.mjs` scans the staged files and the commit message (husky `pre-commit` and
`commit-msg`), and `pnpm run privacy` scans the whole tree. It refuses on any term in
`.sensitive-terms` and on any email outside the synthetic allowlist. `.sensitive-terms` is
gitignored on purpose — add real terms there, never to a tracked file, or the list publishes what
it protects.
