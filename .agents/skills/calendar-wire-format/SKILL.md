---
name: calendar-wire-format
description: Understand and change how Magical decodes Google Calendar data. Use before editing calendar-decoder.ts, calendar-recurrence.ts or the calendar poller, and when an event decodes wrongly, a recurring series doubles up, or an alert fires at the wrong time.
---

# Calendar wire format

The calendar feed is not the Google Calendar API. It is Closure-compiled protobuf carried in
positional JavaScript arrays, behind Google's `)]}'` anti-XSSI guard, fetched with the account's
session cookies. Read
[`docs/magical/calendar-sync.md`'s wire format](../../../docs/magical/calendar-wire-format.md#what-the-endpoint-returns)
before changing the decoder. That document is the living reference; this skill is only the short
list of things that bite.

## Do not copy the field positions here

`IDX`, `ATTENDEE` and `EVENT_TYPE` live in `apps/magical/src/calendar-decoder.ts`, next to the code
that reads them. A table repeating them in a skill drifts out of step silently. Cite `IDX.summary`;
do not transcribe its number.

## Guardrails

- **Pin the positions; never scan the tuple for a field that looks right.** Field additions append
  and deprecations leave holes, so existing fields do not move. A heuristic that matches a plausible
  date picks up a created/updated pair or a reminder time as the event start, and for the alert
  engine that is a banner at the wrong hour, which is worse than no banner.
- This is the opposite of the DOM rule in `AGENTS.md`. Gmail class names are assigned by a minifier
  per build and must be matched by ARIA role; protobuf field numbers are authored once and addressed
  directly. The two look alike and the wrong one is easy to reach for.
- **A decode that fails must throw**, as `CalendarDecodeError`. The throw reaches the staleness
  watchdog and tells the user Magical cannot read their calendar. A fallback reaches them as a wrong
  event.
- **An expiry is not an empty calendar.** Google serves a sign-in page as HTTP 200, so a payload that
  is not the feed is `CalendarSessionExpiredError`, never zero events.

## Recurring series

A recurring meeting arrives as a master carrying the `RRULE`, one materialised event per occurrence
Google has already placed, and the series' own **occurrence schedule** at `IDX.occurrenceList` slot 11.
The schedule is what the client renders from, and `expandRecurringEvents` in
`apps/magical/src/calendar-recurrence.ts` emits the schedule's starts that no materialised occurrence
covers. No rule is ever walked: a cancellation is an omission from the schedule, exactly as it is from
the client's grid, so there is nothing to re-create and no cancellation field to look for.

`parseOccurrenceStarts` reads both spellings: `[<stamp>Z, [null, [epoch]]]` for a timed series and
`[<YYYYMMDD>, [epoch]]` for an all-day one, which is what a working location uses.

The endpoint sends that schedule **only when asked for it**: capability flag 6 in the trailing block
of the request body must be `1` (`buildEventRangeBody` in `calendar-poller.ts`). Send `0`, as the web
client does, and the response carries the rules and the materialised occurrences alone — no schedule,
so nothing can be materialised from it.

Three ways to get it wrong:

- **Never dedupe by id, and never by id alone.** An emitted occurrence is `<seriesId>_R<…>`, a
  materialised one is `<seriesId>_<UTC …>Z`, and Google reuses an id across two events — a contact's
  renamed birthday arrives as a live copy and a yearly master under one id. Key on the id **and** the
  slot.
- **The schedule arrives on a copy the fold may drop.** An `_R` anchor's own occurrence is materialised
  too, and the materialised copy wins the fold; the fold has to carry `occurrenceStarts` across, or the
  series loses its whole future.
- **An all-day entry is a date in UTC.** The wire sends it as a bare epoch at midnight UTC whatever the
  calendar's own zone — `all-day.ts` reads those fields — while a timed event carries its IANA zone at
  `IDX.start[2]`. Reading an all-day epoch with local getters lands a day early west of UTC.

A "this and following" split removes the master record and leaves its occurrences under the same id;
the schedule is then the only source of them, which is why it, and not the rule, is what to trust.
To check any of this against the live feed without running the app, see
[`replaying-the-calendar-wire`](../replaying-the-calendar-wire/SKILL.md).

## Read next

| Subject                                   | Document                                                                                                  |
| :---------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| The format, the envelope and the pipeline | [`calendar-sync.md` wire format](../../../docs/magical/calendar-wire-format.md#what-the-endpoint-returns) |
| The range payload and all-day encoding    | [`calendar-sync.md` range payload](../../../docs/magical/calendar-wire-format.md#range-payload)           |
| Google Tasks, decoded the same way        | [`calendar-sync.md` Google Tasks](../../../docs/magical/google-tasks.md)                                  |

Tests are `apps/magical/tests/calendar-decoder.test.ts` and
`apps/magical/tests/calendar-recurrence.test.ts`. Extend those with a fixture rather
than the live feed; to check the live feed itself, replay a capture.
