# Calendar wire format

Google Calendar's web client does not use the public Calendar API JSON names. This page covers the
raw payload, what the decoder does with it, and the measured field positions. The poller that
fetches it is [`calendar-sync.md`](calendar-sync.md).

## What the endpoint returns

The decoder reads `POST https://calendar.google.com/calendar/u/<index>/sync.prefetcheventrange`.
Google's web client does not use Calendar API v3 JSON names (`summary`, `start.dateTime`,
`conferenceData.entryPoints`); it serialises internal Protocol Buffers into nested positional
JavaScript arrays compiled by Google Closure (`jspb`), preceded by the anti-XSSI guard `)]}'\n\n`.

`stripXssiGuard` removes the prefix and `JSON.parse` reads the rest. A response that is not the feed
is the unauthenticated one, `[["er", null, null, null, null, 401, ...]]`; `isUnauthenticatedResponse`
checks `first[0] === 'er' && first[5] === 401` and `parsePrefetchEventRangeResponse` throws
`CalendarSessionExpiredError`.

### Raw wire response

```json
)]}'

[
  [
    "prefetcheventrangeaction.perr",
    0,
    [
      "<syncTokenBlob>",
      [
        [
          "user@work.com",
          [
            [
              "0r7ud0l6qsg353f6opf5brh3f4",
              0,
              "https://www.google.com/calendar/event?eid=...",
              1733511428000,
              1739211776052,
              "Team Standup & Planning",
              null,
              null,
              null,
              ["user@work.com", null, null, true],
              null,
              null,
              ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"],
              /* ... remaining fields ... */
              [1789027200000],
              [1789030800000]
            ]
          ]
        ]
      ]
    ]
  ]
]
```

## Decoding

### Shape of a clean event

The decoder module [`apps/magical/src/calendar-decoder.ts`](../../apps/magical/src/calendar-decoder.ts)
strips the XSSI prefix and normalises raw tuples into typed `NormalizedCalendarEvent` objects:

```json
{
  "id": "0r7ud0l6qsg353f6opf5brh3f4",
  "calendarIds": ["user@work.com", "team@group.calendar.google.com"],
  "calendarName": "Work Calendar",
  "summary": "Team Standup & Planning",
  "webUrl": "https://www.google.com/calendar/event?eid=...",
  "created": "2026-08-15T10:03:48.000Z",
  "updated": "2026-09-12T14:22:56.052Z",
  "startTime": "2026-09-13T09:00:00.000Z",
  "endTime": "2026-09-13T10:00:00.000Z",
  "isAllDay": false,
  "timezone": "Europe/London",
  "organizerEmail": "user@work.com",
  "recurrenceRule": "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
}
```

### What decoding guarantees

Decoding a dense positional array needs no protobuf library or schema compiler: a mapping function
reads the fixed positions in one pass, which keeps the rest of Magical clear of the wire's quirks.

The stability argument covers one of the three ways this payload can change:

1. **Field additions and deprecations are safe.** jspb indexes by Protocol Buffer field number, so a
   new field appends to the array without moving the fields already there, and a deprecated field
   leaves a `null` hole rather than compacting. Tuple length drifts as a result, so nothing may key
   off it beyond a floor check.
2. **Envelope restructuring is not safe.** A renamed action token, a different nesting of the blocks
   around the events, or a move to a different internal service breaks parsing before any field is
   reached. A Calendar web client rewrite looks like this.
3. **New required request parameters are not safe.** Google web RPCs commonly grow an `at=` XSRF
   token, a `bl=` client build label or a session id as anti-abuse hardening.
   [`calendar-sync.md`'s Zero-OAuth session mechanism](calendar-sync.md#zero-oauth-session-mechanism)
   measured none as required today, a snapshot rather than a contract. Recovery is to read the token
   out of the live calendar page in the account's `WebContentsView`.

### Pinned indices

The decoder reads each field at the position its field number gives it, validates the type and range
of what it finds, and throws when the value is not there. The positions live in `calendar-decoder.ts`
as `IDX`, `ATTENDEE` and `EVENT_TYPE`, beside the code that reads them; a table repeating them here
would drift out of step silently.

Protocol Buffer field numbers are assigned by a schema author once and never renumbered, because
renumbering breaks Google's own rolling deploys. A field addition appends and a deprecation leaves a
hole, so existing fields do not move. Scanning for a field by shape defends against a case that does
not happen, since no amount of scanning inside a tuple helps with envelope restructuring or a new
request parameter, and it turns a loud failure into a quiet wrong one: an adjacent created/updated
pair, or a reminder time, read as the event start puts a banner at the wrong hour. A pinned field
that no longer matches is a one-line fix found by a failing canary.

A decode that fails throws `CalendarDecodeError`. The throw reaches the staleness watchdog, which
tells the user Magical cannot read their calendar; a guess reaches them as a wrong alert. An unreadable
event in a response throws rather than being skipped, so a change to one pinned field number cannot drop
events while health stays `ok`.

## Features the decoder resolves

### Event title and times

`IDX.summary` (5) carries the title, and `parseEventTuple` falls back to `(No title)`. `IDX.start`
(35) and `IDX.end` (36) carry the two timestamps, read by `parseTimestampTuple`. `IDX.created` (3)
and `IDX.updated` (4) carry two epoch numbers, null when absent rather than defaulted to now, which
would read as a fresh event.

All-day is the shape of the start, not a flag. A timed event carries `[null, [epochMs], "Europe/London"]`;
an all-day entry carries a bare `[epochMs]` with no timezone, so `isAllDay` reads the absence of the
timezone. It mirrors the public API, where an all-day event has `start.date` and a timed one has
`start.dateTime`. There is no boolean all-day flag anywhere in the payload.

Because the wire states an all-day event as an instant at exactly midnight UTC, the date it is on is
that instant's UTC fields, and the machine's zone is never the reader. Every surface that renders or
buckets an all-day date follows that date — the invitation line (`formatInviteWhen` and the banner's
`formatInviteLine`), the day a link carries (`buildEventLink`), the widget density grid (`daysCovered`),
the Swift popover and widget agenda, and the working-location collapse — while a timed event stays on
the Mac's zone. `apps/magical/src/all-day.ts` is the single reader: `allDayKey` and `allDayLocalDate`
take the UTC fields, and a multi-day all-day event's end is exclusive, so it covers each date from its
start to its end minus one. Read the instant with local getters instead and every birthday, holiday
and working location is a day early west of UTC.

The loaded-day ledger is the exception in wording only. Its coverage answers "was this range fetched",
so `isCoveredByLoadedDay` judges an event on its instants, all-day and timed alike, while the UTC date
is only how the day is drawn. Keying coverage on the date instead drops an all-day event one day past
the window edge west of UTC.

`isValidCalendarDate` bounds a decoded date to 1900 to 2100. The window is wide because a calendar
legitimately holds dates far outside a working year: a birthday from Contacts carries the person's
year of birth, and one born before the lower bound would throw and take its whole account's payload
with it.

### Pending invitations

An event is awaiting a reply while the account holder's response code is `0`. Each event carries its
guest list at `IDX.attendees` (20), and each guest carries their response at `ATTENDEE.responseStatus`
(5). The response codes, measured against a live account:

| Code | Meaning     |
| ---: | :---------- |
|  `0` | No response |
|  `1` | Declined    |
|  `2` | Tentative   |
|  `3` | Accepted    |

One guest carries `ATTENDEE.ownsThisCalendar` (9), but that flag names the owner of the calendar this
copy arrived under, not the signed-in user; on a colleague's calendar it flags the colleague.
`parseEventTuple` finds the account holder by address instead, and their response is the same in every
copy. Without an address to look for, the flag is the best available guess and is right whenever the
block is the account's own calendar.

"Not invited" is a third state, distinct from "invited and unanswered". An event visible on a shared
calendar that the user is not a guest of is not awaiting their reply, and badging it as such would
light the Dock up permanently. `myResponseStatus` reads `'notInvited'` for it.

`invite-watcher.ts` spots the ones that are pending:

```ts
export function isPendingInvite(event: NormalizedCalendarEvent): boolean {
  return event.myResponseStatus === RESPONSE_NEEDS_ACTION;
}
```

`inviteKey` keys the series rather than the occurrence, so one invitation to a recurring meeting is
announced once. A notification banner opens the event rather than answering it; neither of Google's
two answer routes is usable, and answering drives Google's own controls instead.
[`actions.md`'s Answering an invitation](actions.md#answering-an-invitation) owns the mechanism.

### Conference links

`resolveConferenceUrl` reads three sources in order:

1. **The structured conference block**, at `IDX.conference` (57). Its first element is a list of
   entry points, each `[typeCode, uri, label, ...]`, where `typeCode` `3` is the video entry and `4`
   and `5` are dial-in numbers; its last element is the conference id. Decode this one, because it
   covers third-party conferencing added through Google's conferencing API rather than only Meet.
2. **The bare Meet URL**, at `IDX.meetUrl` (45), the legacy `hangoutLink` equivalent. Cheap to read,
   but Google Meet only.
3. **The free text**, `IDX.description` (64) first and `IDX.location` (7) second, scanned by
   `findJoinUrlInText`.

Read the conference block for the video entry point and fall back to the Meet URL. The committed
fixture has an empty conference block because sanitisation stripped it, not because the field was
absent. Conferencing that was never registered with Google leaves all three empty; that is the common
Teams case, where the invitation body carries the join link. [`conference-links.md`](conference-links.md)
owns how that body is scanned and how the URL is resolved and launched.

### Working locations

`IDX.eventType` (82) carries `10` on a recurring working location and `11` on one set for a single
day. Measured against a live account, "Home", "Office" and a named office all arrive as `10` when
they belong to a series and as `11` when the user sets one for a single day. Both draw the same way.

Which location it is comes from the title, because nothing else carries it. Google's own Calendar API
has a `workingLocationProperties.type`, and it reports `HOME_OFFICE` for a home day, for one titled
"Office" and for a named office alike. Google generates all three titles it owns, being "Home",
"Office" and "<name> (Office)" for one of the organisation's offices; anything else is a label the
user typed, and takes the pin. `workingLocationGlyph` in `WidgetCache.swift` maps the title to
`house`, `building.2` or `mappin.and.ellipse`. This heuristic is safe here because it runs only once
the wire has said the entry is a working location, and a wrong guess costs one glyph rather than
arming an alert at the wrong hour.

A day has a regular working location, and the user overrides it a day at a time. The override does
not cancel the regular entry: the series carries no `EXDATE`, the occurrence is not tombstoned, and
Google's own API reports both as confirmed. Google draws only the override, which is why its client
shows one where a faithful decode shows two. `collapseWorkingLocations` in `working-locations.ts`
does the same, keeping the override over the series occurrence and the later of two overrides. It
runs over the merged cache rather than the fetched list, because the entry an override replaces may
have arrived in an earlier poll. This covers the all-day entry, the one that states where the day is
spent; a working location given a time is an appointment like any other, and two ordinary all-day
events on a day both stay.

### Out of office

`IDX.eventType` (82) carries `3`. The decoder reads it into `eventType`; nothing draws it, and
`alert-scheduler.ts` excludes all-day entries, so an out-of-office block arms no alert. It sits on
the account's own calendar and reads as an ordinary appointment by every other measure.

### Focus time

`IDX.eventType` (82) carries `7`. Focus Time entries draw with a `headphones` glyph before the title,
from `kindGlyph` in `TrayModel.swift` and `WidgetCache.swift`.

**A time-blocked task is one of these.** Google Tasks materialises a task's block as a focus-time
event, so `82` reads `7` for it too. `IDX.taskBinding` (61) is what tells the two apart: its own
slot 6 holds the Tasks id for a task, and `parseEventTuple` reads that id rather than the slot.

### Reminders

`IDX.reminders` (33) carries the event's own notification times, present only when it overrides its
calendar's. A list of `[method, minutes]`, as `[[2,15],[2,5]]` for two notifications or `[[0,10]]` for
an email, where `REMINDER_NOTIFICATION` is `2` and `REMINDER_EMAIL` is `0`. `parseEventTuple` keeps
the notification entries only, since an email reminder is not one this app can deliver and the alert
engine would treat its minutes as a banner time. `alert-scheduler.ts` takes the longest of them with
`Math.max`, which is the earliest banner.

An event that takes its calendar's default carries nothing here, and so does one whose notifications
the user has removed; the two cannot be told apart from this payload, and the calendar's own default
is not in the payload at all. Both fall back to the global lead.

### Colour

An event names a colour label rather than a colour. `IDX.eventLabel` (91) carries the uuid of the
label the event overrides its calendar with, present only when it overrides. `readLabelColours` reads
the account's whole label set from `payloadBlock[2]`, `[null, "<labelId>", <colourId>, ...]` per
calendar, and maps each label to a hex through `colourForId`; `parseEventTuple` resolves the event's
label to `colorHex`.

The wire carries a colour id and not a hex, and `colourForId` resolves it against the checked-in
palette: [`google-colours.json`](../../apps/magical/src/google-colours.json) holds the 24 hexes in
file order, the position being the id. Peacock, id 14, is `#039BE5`, the colour Google paints an
account's own calendar. The palette is checked in rather than read at runtime because it is static;
Google has remapped it once, and if it happens again these hexes are what goes stale, visibly.

Calendar colours arrive in the calendar list (`sync.sync` / `initialdata`), not on the range payload.
A calendar using one of Google's 24 presets resolves its colour index through `colourForId`; a calendar
with a custom colour carries the packed RGB integer in `colour[5]`, which `resolveCalendarColour`
unpacks into hex.

### Event kind

`IDX.eventType` (82) is the only thing that separates entries every other field reads alike. Tasks
and contact birthdays have no block of their own: asking for `tasks@tasks.google.com` or
`birthdays@birthdays.google.com` returns an empty payload even when it is the only calendar named, so
their entries arrive inside the primary calendar's block and nothing keyed on a calendar id separates
them from an ordinary appointment. A title heuristic is not a substitute: an ordinary event with
"birthday" in its name is `DEFAULT`.

| `eventType` | Entry            | Glyph                                         |
| ----------: | :--------------- | :-------------------------------------------- |
|         `1` | From Gmail       | none                                          |
|         `3` | Out of office    | none                                          |
|         `7` | Focus time       | `headphones`, or `circle` for a task block    |
|   `10` `11` | Working location | `house`, `building.2` or `mappin.and.ellipse` |
|        `13` | Birthday         | `birthday.cake`                               |

An entry has one `eventType`, so it gets one glyph: `kindGlyph` in `TrayModel.swift` and
`WidgetCache.swift` maps it. A contact birthday carries the contact's id at `IDX.contact` (83).
`FOLDED_INTO_PRIMARY` re-files a birthday onto `birthdays@birthdays.google.com` and a task onto
`tasks@tasks.google.com`, so the entry takes that calendar's colour and name and leaves the screen
when the user hides it.

A task's time block is typed as focus time on the wire, so `EVENT_TYPE.TASK` is not something Google
sends for it. `IDX.taskBinding` (61) is what identifies the entry as a task, and that same value
labels the rows the app builds from the Tasks sync.

## Recurring series

The payload carries a recurring meeting in two forms at once, and both decode into ordinary events.

### Double arrival

The series master holds the `RRULE` at `IDX.recurrence` (12) and starts on the series' first date,
which for a birthday is 1958. Alongside it comes one event per occurrence Google has already
materialised, its id stamping the series and the start the rule gave that occurrence in UTC,
`<seriesId>_20260918T084000Z`, and its `seriesId` at `IDX.seriesId` (13) naming the master. A
materialised occurrence is a complete event and is kept as one.

A series that has been **edited** can send one occurrence twice over, both times as a materialised
event: the occurrence the edit anchored the series to arrives under `<seriesId>_<slotUTC>Z` and under
the series' recurrence id `<seriesId>_R<slotUTC>`. The two ids name one occurrence, and the edit can
leave them disagreeing even on the time, because the materialised copy carries the move and the
recurrence copy still holds the slot. `parsePrefetchEventRangeResponse` folds them together; see
"Range payload" below.

### The series' own schedule

Magical does not expand a rule. The wire states the occurrence set outright, and that set is what the
client itself renders from.

`IDX.occurrenceList` (63) is a container, and its slot 11 is the series' schedule: one entry per
occurrence, hundreds of entries running years ahead. An entry is `[stamp, payload]`, where the stamp
is `20260918T084000Z` for a timed series and a bare `20260918` for an all-day one. A working location
— `Home` on Mondays, `Office` on Thursdays — uses the all-day spelling; every other series uses the
timed one. `parseOccurrenceStarts` reads both spellings into `occurrenceStarts`.

**The endpoint sends the schedule only to a client that asks for it.** Capability flag 6 in the
body's trailing block does that: `buildEventRangeBody` in `calendar-poller.ts` sets it to `1`. With
that bit `0` — what the shipping web client sends, because it expands the rules itself — the same
request comes back with the rules and the materialised occurrences alone and **no schedule at all**.
Measured for one work account's 12 calendars and the poll window: `0` gave 45 masters and no
schedule, `1` the same 45 masters and 46 schedules. An app that materialises from the schedule has to
send the bit; without it, every occurrence Google has not placed is absent from the answer.

`expandRecurringEvents` in `calendar-recurrence.ts` then emits the schedule's starts that no
materialised occurrence already covers. Where a schedule exists it is authoritative and no rule is
walked: **a cancellation is an omission from the schedule**, exactly as it is from the client's grid,
so a cancelled occurrence is not in the set to be re-created. The schedule is also the only source
for a series whose master record a "this and following" split has removed — there is no rule left to
read, so deriving occurrences from one cannot work at all.

The schedule lives on the master and on each `_R` anchor, and a series' set is the union across them:
an anchor covers the span from its own split onward, while what precedes it is materialised. A
schedule entry carries an instant, so the series' zone never enters into placing it.

Three things make this easy to get wrong:

- **The two forms of id never match.** An emitted occurrence is
  `<seriesId>_R<YYYYMMDDTHHMMSS>` and a materialised one is `<seriesId>_<UTC YYYYMMDDTHHMMSS>Z`, or
  `<seriesId>_<YYYYMMDD>` when it is all-day. Comparing ids leaves both in the agenda, and the alert
  engine then rings twice for one meeting, ten minutes before it starts. The wire spells ids with the
  `_R` form as well — as `IDX.seriesAnchor`, and as the id of one copy of an edited series' anchor
  occurrence — so an id is never on its own the identity of an occurrence.
- **The schedule arrives on a copy the fold may drop.** An anchor's own occurrence is materialised
  too, and the materialised copy wins the fold against the `_R` copy carrying the schedule; the fold
  has to carry `occurrenceStarts` across, or the series loses its whole future.
- **An id can be reused across two events.** A contact's renamed birthday arrives as a live copy and
  a yearly master under one id. Dedup keys on the id and the slot, so distinct occurrences both stand
  and only an exact duplicate collapses.

### Stale master

The master is the series' **first occurrence**, frozen at the name, location and response it had
then. Google does not rewrite it when a later change renames the series or answers it; the current
state lives only on the occurrences materialised after the change. A stand-up whose master still
reads "Legacy stand-up" with `myResponseStatus` 0 can have every instance since the rename reading
"Current stand-up" and accepted, all sharing one `seriesId` and even one `IDX.updated`.

So an emitted occurrence is built from the **newest** materialised instance of the series, falling
back to the master, or to the anchor that carried the schedule, only when the wire materialised none.
Identity and clock stay the series'; summary, attendees, response, location, length and the rest are
the instance's.

## Range payload

Where each field sits is `IDX`, `ATTENDEE` and `EVENT_TYPE` in `calendar-decoder.ts`; those positions
belong beside the code that reads them. What is worth saying here is the shape, which no list of
fields conveys.

**An event comes back once per calendar that holds it, and Magical records every one.**
`parsePrefetchEventRangeResponse` folds the copies together by the occurrence they are a copy of —
the `uid` at `IDX.uid` (18), the series id and the slot stamped in the id — into a single event
carrying all their calendars in `calendarIds`, rather than picking a copy. The id cannot be the key
on its own: an edited series sends one occurrence under two ids, and the copies of a **moved**
occurrence do not even share a start time, so the slot is read out of the id rather than off the
clock. The uid cannot be the key on its own either, because a "this and following" split can carry
one iCalendar uid across both halves and their occurrences meet at the split slot: without the
series id, the old series' truncation tombstone would fold away the replacement's first occurrence
and the meeting would disappear. Anything needing one calendar, for a colour or a name, takes the
first the user has not hidden; a filter drops the event only when it hides all of them. Two objects
for one meeting would arm its alert twice and count it twice in the Dock badge.

Because that invariant is what the whole recurrence path exists to keep, and the path has already
been wrong in several different ways, `CalendarService.foldIntoCache` runs a canary over the merged
agenda. `event-duplicates.ts` groups the list by `uid` and start and logs a warning naming the
account and the colliding ids for any group of two or more. The title is not part of the key, so
three candidates sharing one interview slot are left alone. A meeting is reported once rather than
on every poll, and the warning is the signal to look for: a regression nobody predicted shows up in
`main.log` instead of as a double on screen.

**A cancelled occurrence is usually simply absent from the series' schedule.** Google removes it
from the occurrence list rather than sending a deletion, which is why the ordinary case needs no
cancellation logic — the app emits the schedule, and the cancelled slot is not in it. The client's
own grid works the same way.

The exception is the live `_R` anchor row of a split. Deleting the anchor's own occurrence removes
its slot from the schedule the row carries, but the row itself stays live and still supplies the
schedule for the rest of the series. Emitting every live non-master row therefore puts the deleted
occurrence back. The schedule is authoritative for the anchor's own slot too: the expander emits the
anchor's future starts and drops the row itself when that slot is not in the schedule. The
`sync.sync` delta carries an explicit tombstone for the deletion, `[id, 2, …]`, but the range payload
does not.

The range payload can also carry a tombstone — `IDX.status` (1) is `2`, usually on a short tuple with
no times — and only two kinds matter:

- **A tombstone for the master's own id** means the series record was removed. A "this and following"
  split deletes the old master and hands its occurrences to the replacement under the same series id,
  so the occurrences still returned under that id are kept. The `_R` anchor spelling marks such a
  split; it is read with or without the trailing `Z` the materialised form carries, because the two
  ids name the same occurrence.
- **Anything else tombstoned** — a standalone event, or one that names a slot — is dropped, and a
  tombstoned master with a slot ends its series.

`expandRecurringEvents` drops the tombstones, drops a delisted anchor row, and emits the rest.

`IDX.calendar` (34) names the calendar holding the event's canonical copy, which for an invitation is
the organiser's. The calendar a copy sits on is the block it came back under. Read as "this event's
calendar", `IDX.calendar` gives every invitation a calendar the user does not have, so nothing keyed
by calendar id matches: not the colour, not the name, not the popover's hidden-calendar filter.

`IDX.webUrl` (2) carries the link whose `eid` names a calendar; the merge keeps the account's own
copy so the link can find the chip Google draws for the user. `IDX.syncVersion` (39) is present where
the payload carries one.

**A calendar block echoes the range that was asked for and carries nothing else about the calendar**:
no name, no colour. A block is `[id, [event, ...], [null, null, startDay, endDay], n]`. `n` is the
event count the wire claimed for that calendar block; `parsePrefetchEventRangeResponse` compares that
figure against what it decoded and throws `CalendarDecodeError` if fewer events decoded.

**The committed fixture is sanitised, and sanitisation moved a field it did not move consistently.**
Its contact birthday carries a summary replaced with a meeting's, while the fields that identify it
as a birthday were left untouched. The fixture is adequate for decoder unit tests and misleading for
field discovery; measure against a live account.

### Prefetch and fetch

The live client calls both `sync.prefetcheventrange` and `sync.fetcheventrange`, and they are not
different schemas: the same fields are populated in either, descriptions and conference blocks
included. They differ only in how the client uses them: prefetch calls name more calendars over a
wider range, fetch calls fewer over a narrower one. That is a caller's choice rather than a property
of the endpoint, and either serves the poller. `prefetcheventrange` remains the documented primary
because it is already the subject of
[`calendar-sync.md`'s Zero-OAuth session mechanism](calendar-sync.md#zero-oauth-session-mechanism)
and the canary.

## Capture protocol

Everything on this page was read from a live signed-in account inside Magical's own
`WebContentsView` over CDP, by recording Google Calendar's own requests rather than crafting any.

Run against the account's own `WebContentsView` in a running build, not a browser. A browser console
proves the endpoint answers; only the in-app path proves Magical's partition, with its Chrome
identity headers, is served the same payload.

Record the real client's traffic rather than constructing a request: it removes any guesswork about
the `f.req` body and the required headers.

Captures contain real event titles, attendee addresses and meeting URLs. Keep them out of the
repository, and hand-redact before any of it becomes a fixture.
