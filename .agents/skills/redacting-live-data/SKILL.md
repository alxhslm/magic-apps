---
name: redacting-live-data
description: Use when debugging against a live Google account — capturing the wire payload, reading main.log, decrypting the local caches or attaching CDP. Keeps real client, colleague, candidate and account identifiers out of tests, docs, fixtures and commit messages. Load before any captured value is written into a tracked file.
---

# Redacting live data

A live capture is the best evidence there is, and the most dangerous thing to paste. The real
client name, the colleague's address, the series id and the venue are what make the data
recognisable, so they are exactly what a test, a doc example or a commit message reaches for. That
has leaked before. This is the procedure that stops it.

## Rules

- A live capture lives **outside the repo**: `/tmp/magical-capture.json`, never a fixture.
- Nothing real is ever written into a tracked file. Not a client name, a personal address, a real
  calendar or series id, a `uid`, a Meet slug, a venue or an event summary.
- Do the substitution **while capturing**, before a test or doc exists. A capture that has already
  been copied into a fixture is a leak that has to be hunted through history.

## Procedure

1. Capture to `/tmp` (CDP response, decrypted cache, log slice).
2. Build a real→placeholder table as you read it, e.g.

   | real                | placeholder         |
   | :------------------ | :------------------ |
   | client product name | `Current stand-up`  |
   | series id           | `example_series_id` |
   | venue               | `Example Room 4`    |
   | person's address    | `someone@work.com`  |

3. Write tests and docs only from the placeholder column.
4. Keep a second copy of the capture with substitutions applied if it is worth keeping; never keep
   the raw one in the tree.
5. Run `pnpm run privacy`, or commit and let the husky hooks run. They scan the staged files **and** the
   commit message against `.sensitive-terms` (gitignored) and against any non-synthetic email.

## When the gate fires

Replace the real value with a synthetic one. If a real term is still missing from the local
`.sensitive-terms`, add it there — the file is gitignored, and a tracked denylist would publish the
names it is meant to protect.
