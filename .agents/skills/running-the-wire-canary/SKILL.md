---
name: running-the-wire-canary
description: Check that the calendar sync feed format remains up to date and compatible with Magical's decoder. Use when calendar event sync or alerts need verification or after editing calendar-decoder.ts.
---

# Running the Calendar sync format canary

`tools/wire-canary.mjs` connects to a running Magical instance to verify that the live calendar
sync feed matches the schema and field indices expected by [`calendar-decoder.ts`](../../../apps/magical/src/calendar-decoder.ts).

Static unit test fixtures verify decoder logic against saved snapshots, but only a live run against
current feeds confirms that the application's decoder remains completely up to date.

## Privacy & Ephemerality

The canary evaluates feed data **strictly in memory**:

- **Zero disk writes**: No responses or parsed event records are saved to disk or fixtures.
- **Zero caching**: The feed payload is evaluated in-memory and immediately discarded.
- **No data logging**: Event titles, summaries, descriptions, attendee emails, and meeting links are never logged or printed. Only array lengths, index positions, and data types are checked.
- **Run against a test account**: Always run with Magical in `--demo` mode signed into a dedicated test account. Never point the canary at your primary personal profile.

## 1. Give it something to read

Everything below is load-bearing:

- **The core and Magical built**, because the decoder is loaded from the package build:

  ```bash
  pnpm --filter @magimail/core run build
  pnpm --filter magical run build
  ```

- **Magical running in demo mode, with its debug port.** Start it by running the executable directly,
  **not** `open -a … --args`:

  ```bash
  nohup /Applications/Magical.app/Contents/MacOS/Magical --demo --debug-port=9223 >/tmp/magical-demo.log 2>&1 &
  ```

  `--demo` resolves userData to `Magical-demo` and isolates the run from the App Group and your real accounts.

- **A signed-in test account.** If the window shows Google's login screen rather than a calendar grid,
  sign into your dedicated test account once. The canary uses the existing session cookies held in
  Chromium's cookie jar.

## 2. Seed the 4 broad coverage benchmark scenarios

An empty calendar tests only the envelope. Rather than testing edge cases piecemeal, four compound
benchmark events provide broad coverage across every wire dimension, clock encoding, and lifecycle mutation.

> [!TIP]
> **Using a personal account MCP token**: If your Google Workspace MCP server is authenticated
> to your personal account rather than the test account, create the benchmark events on your
> personal calendar and include the test account in `attendees` (e.g. `attendees: [{ "email": "test-account@gmail.com" }]`),
> specifying `sendUpdates: "none"` to suppress email notices. Google delivers the invitation directly
> to the test account's calendar without emailing anyone.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        BROAD COVERAGE MATRIX                           │
├──────────────────────┬─────────────────────────────────────────────────┤
│ Benchmark Scenario   │ Feed Schema & Fields Exercised                  │
├──────────────────────┼─────────────────────────────────────────────────┤
│ 1. Evolving Series   │ RRULE, instances, EXDATE, _R anchors, tombstones│
│ 2. Video Meeting     │ Meet links, guest list, RSVP, reminder override │
│ 3. All-Day Milestone │ Midnight UTC timestamp encoding, day boundaries │
│ 4. Special Event     │ Event kinds (Focus/OOO), color labels           │
└──────────────────────┴─────────────────────────────────────────────────┘
```

### Scenario 1: The Evolving Series (Recurrence & Lifecycle Mutations)

Exercises the full recurrence lifecycle, including series masters, materialized instances, exclusions,
duplicate anchor delivery, and tombstone filtering:

1. **Create the base series** with occurrence limit via Google Workspace MCP `create_event`:
   ```json
   {
     "calendarId": "primary",
     "summary": "[Magical Canary] Weekly Team Sync",
     "start": "2026-10-05T09:00:00Z",
     "end": "2026-10-05T09:30:00Z",
     "recurrence": ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=10"]
   }
   ```
2. **Rename the series ("All future events")**:
   Use `update_event` to change `summary` to `"[Magical Canary] Active Team Sync"` with `sendUpdates: "all"`.
   _Verification effect_: The master remains frozen at the original title while materialized instances carry the new title.
3. **Move one occurrence ("This event only")**:
   Shift one instance forward by 2 hours via `update_event`.
   _Verification effect_: Master rule gains `EXDATE:`. The moved instance keeps the slot UTC in its ID while start time (`[35]`) shifts. Also generates dual-delivered `_R` anchor.
4. **Delete one occurrence ("This event only")**:
   Delete an instance via `delete_event`.
   _Verification effect_: Generates a cancelled tuple with `IDX.status === 2` (tombstone).

### Scenario 2: The Multi-Attendee Video Meeting (Collaboration & Entry Points)

Exercises attendee guest lists, RSVP status codes, conference entry points, and custom reminder overrides:

Create a single compound meeting via `create_event`:

```json
{
  "calendarId": "primary",
  "summary": "[Magical Canary] Product Review & Planning",
  "description": "Agenda and video conference entry points",
  "location": "Virtual / Room B",
  "start": "2026-10-06T14:00:00Z",
  "end": "2026-10-06T15:00:00Z",
  "attendees": [{ "email": "test-attendee@example.com" }],
  "conferenceData": {
    "createRequest": {
      "requestId": "canary-meet-002",
      "conferenceSolutionKey": { "type": "hangoutsMeet" }
    }
  },
  "reminders": {
    "useDefault": false,
    "overrides": [
      { "method": "popup", "minutes": 15 },
      { "method": "popup", "minutes": 5 }
    ]
  }
}
```

_Verification effect_: Populates `IDX.attendees` (20), `IDX.meetUrl` (45), `IDX.conference` (57), `IDX.reminders` (33),
`IDX.location` (7), and `IDX.description` (64).

### Scenario 3: All-Day Milestone (UTC Clock Encodings)

Exercises midnight UTC date encoding versus local timezone readers:

Create an all-day entry via `create_event`:

```json
{
  "calendarId": "primary",
  "summary": "[Magical Canary] Sprint Release Milestone",
  "start": "2026-10-08",
  "end": "2026-10-09"
}
```

_Verification effect_: Validates Format 1 timestamp array (`[epochMs]`) without timezone string, asserting correct UTC date walking.

### Scenario 4: Special Event Kinds (Event Types & Color Overrides)

Exercises non-default event types and custom color labels:

Create a Focus Time or Out of Office block via `create_event`:

```json
{
  "calendarId": "primary",
  "summary": "[Magical Canary] Focus Time Block",
  "start": "2026-10-07T15:00:00Z",
  "end": "2026-10-07T17:00:00Z",
  "eventType": "focusTime"
}
```

_Verification effect_: Populates non-zero `IDX.eventType` (82), asserting proper glyph assignment and primary calendar folding.

> **Wait for the grid to update**: After seeding events via MCP, wait 5–10 seconds for Google Calendar's
> live web client to poll and receive the new entries before running the canary.

## 3. Run it

```bash
node tools/wire-canary.mjs
```

`--port` overrides the default (`9223`), and `--target <string>` filters by account title if multiple
views are open.

## 4. Read it

- **pass** — Envelope, anti-XSSI guard, sync token, calendar blocks, pinned indices (ID, status, timestamps, summary, recurrence, event type), and the production decoder all succeed.
- **Coverage: [Feature]** — Shows which feed capabilities were observed in the polled window:
  - `Coverage: Recur (COUNT)` — Series with occurrence count limits
  - `Coverage: Recur (UNTIL)` — Series with explicit end dates
  - `Coverage: Recur Instances` — Materialized and exception occurrences folded
  - `Coverage: EXDATE Rules` — Recurrence exclusions and moved occurrences
  - `Coverage: Tombstones` — Cancelled occurrences decoded with `isCancelled: true`
  - `Coverage: Video Conf` — Google Meet conference links
  - `Coverage: Attendees` — Multi-attendee guest lists and RSVP statuses
  - `Coverage: All-Day` — UTC midnight date bounds
  - `Coverage: Special Kinds` — Non-default event types (Focus Time, Out of Office, Working Location)
  - `Coverage: Reminders` — Custom notification lead time overrides
- **fail** — An expected index moved, a timestamp format changed, or the decoder threw `CalendarDecodeError`.
  Compare the reported index error with the live payload structure and update `IDX` in `apps/magical/src/calendar-decoder.ts`.
- **[AUTH EXPIRED]** — HTTP 401 or sign-in page returned. Log into the test account in the demo window and re-run.

## 5. Teardown / Cleanup

After verifying the canary, clean up all seeded test events using the Google Workspace MCP tools:

1. Call `list_events` with `q: "[Magical Canary]"`.
2. Call `delete_event` for each matching `eventId`.
3. Confirm no `[Magical Canary]` entries remain on the test calendar.

## 6. What it cannot do

- **It cannot run on hosted GitHub Actions runners.** Web calendar sync sessions require an active browser session cookie and cannot be polled from unauthenticated cloud runners.
- **It is not a PR merge gate.** Upstream feed updates occur independently of repository commits; this is an operational canary run periodically or when verifying sync health.
