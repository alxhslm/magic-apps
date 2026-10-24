---
name: replaying-the-calendar-wire
description: Replay a captured calendar range payload through the production decoder and recurrence expander offline, and diff the result against Google's API. Use when a recurring event, an all-day date, a cancelled occurrence or a series split has to be checked against the real feed, or after changing calendar-decoder.ts, calendar-recurrence.ts or the poller.
---

# Replaying the calendar wire

The running app hides its feed. To see exactly what the wire carries on a given date, and what the
decoder and expander make of it, capture the payload once and replay it: no poll to wait for, no
reinstall, and the whole window at once.

Two tools do the work, and neither is a test: `tools/capture-calendar-wire.mjs` saves the payload,
`tools/calendar-truth.mjs` saves what Google's API says, and `tools/replay-calendar-wire.mjs` runs the
capture through the production code and prints the disagreements.

**Captures and truth files are the account's own data.** Write them under `/tmp` and leave them
there — never into the repo, a fixture, a doc or a commit message. Read
[`redacting-live-data`](../redacting-live-data/SKILL.md) before any value is copied anywhere.

## 1. Build, and run Magical on the account you want

```bash
pnpm --filter magical run build
nohup /Applications/Magical.app/Contents/MacOS/Magical --debug-port=9223 >/tmp/magical.log 2>&1 &
```

The capture asks the calendar page for its own session, so the account being captured must be the
**active** one. Switch accounts with the app's **Accounts** menu; the debug port then exposes that
account's page.

## 2. Read the account's calendar list

A capture asks for a list of calendar ids. Asking for the primary alone misses whole calendars — the
ATS, the team's PTO feed, a family calendar — and every event on them then reads as missing. The real
list is in the App Group's `accounts.json` (`…/Group Containers/<group id>/accounts.json`), one
`calendarIds` array per account, next to the partition names.

## 3. Capture, per account

```bash
node tools/capture-calendar-wire.mjs --out /tmp/corpus/work.txt \
  --calendars-file /tmp/corpus/work-calendars.json
```

`--calendars-file` takes the JSON array of ids; `--calendar <id>` repeated works too, but a dozen ids
as shell arguments invites quoting mistakes that come back as an empty payload rather than an error.
Magical keeps a calendar view alive per account, so several pages answer on the debug port and they
are not interchangeable: the tool tries each and keeps the one that returns events, which is the
page belonging to the account that holds those calendars.

**The capture must ask for the schedules.** The tool sets capability flag 6 in the request body,
which is what makes the endpoint include each series' occurrence schedule; without it the same
request answers with rules and materialised occurrences only. If a capture's rows report
`withSchedule=0`, it is the wrong shape and any "missing" it reports is about the capture, not the
app.

**Use the app's own window** — the defaults, `--back 9 --ahead 62`. This matters more than anything
else here: ask for a wider window and Google answers a _different question_. Far-out series come back
as a summarised feed with no occurrence schedules and no master tombstones, which manufactures both
missing events and phantom ones. Nearly every false finding in this workflow came from a wide capture.

## 4. Fetch the truth over exactly the same window

```bash
node tools/calendar-truth.mjs --credentials-dir ~/.google_workspace_mcp/credentials \
  --emails me@example.com --from 2026-10-02T00:00:00Z --to 2026-12-12T23:59:59Z \
  --out /tmp/corpus/truth.json
```

The window must match the replay range character for character. `time_min` is a **time**, not a day:
a `now − 9d` window cuts off the first morning of the range and turns every event in it into a
disagreement.

## 5. Replay

```bash
node tools/replay-calendar-wire.mjs --map /tmp/corpus/map.json --truth /tmp/corpus/truth.json \
  --from 2026-10-02T00:00:00Z --to 2026-12-12T23:59:59Z
```

`map.json` is `{ "<capture path>": "<account email>" }`.

## Reading the diff

- **The API returns one entry per calendar and the app folds them.** A meeting on two calendars comes
  back twice with a _different title per calendar_; the app shows one event. Matching is therefore on
  **uid + instant**, with title + instant only as a fallback (an imported calendar spells its
  `iCalUID` differently from the wire's `uid`).
- **Before believing a `MISSING`, look for the event in the capture.** If the wire has no row for it —
  neither materialised nor in the series' schedule — the app cannot show it and the API is simply
  ahead of the feed. Search the whole tuple, and include short six-element master tombstones, which a
  filter on tuple length misses.
- **Remainders that are expected**, not defects: a multi-day absence starting before `time_min`; an
  event moved or cancelled _after_ the capture was taken, which the API reflects and the capture
  cannot; the imported-calendar uid difference above.

## Where the occurrences come from

The app does not expand recurrence rules. A recurring series carries its own **occurrence schedule**
at `IDX.occurrenceList` slot 11, and that set — unioned across the series' `_R` anchors, plus the
occurrences the wire materialised — is what is shown. A cancellation is an _omission_ from that
schedule, which is why there is no cancellation field to look for and no rule to re-create it. Read
[`calendar-wire-format`](../calendar-wire-format/SKILL.md) before touching the decoder.
