# Local calendars (EventKit)

`eventkit-source.ts` does not exist; `CalendarPoller` is the only source today.

## Why a second source

The session poller reaches Google and nothing else. EventKit reaches iCloud, Exchange and local
calendars, which no Google transport can, and it carries two things the wire format does not:
per-event reminder overrides, free from `EKEvent.alarms`, and a push signal on `EKEventStoreChanged`.

It is a secondary source rather than the primary one because of onboarding, not data quality. Magical
is a front-end for a Google account the user has already signed into inside Magical; EventKit would
ask them to sign into the same account again in System Settings, and to turn off macOS Calendar's own
alerts so they do not get every banner twice.

## Fitting the source contract

The contract exists and `CalendarPoller` implements it
([`calendar-sync.md`'s The source contract](../../docs/magical/calendar-sync.md#source-contract)).
A second source widens two fields and changes nothing else:

```ts
readonly id: string; // 'google:account_personal' | 'eventkit:local'
readonly kind: 'google-session' | 'eventkit';
```

`onChanged` becomes useful here: the poller drives it from its own tick, whereas EventKit can push
on `EKEventStoreChanged`, so an EventKit source reports a change when one happens rather than when it
is next asked.

The payoff is one install running the session poller for a Google account and EventKit for an iCloud
calendar at the same time, with the alert engine unable to tell them apart.

### Absence must be distinguishable from ignorance

`NormalizedCalendarEvent` is defined by what an alert needs rather than by what either transport
returns, and the two sources fill different subsets of it. The wire format has no measured index for
per-event reminders; EventKit has `EKEvent.alarms`. EventKit flattens Out of Office; the wire format
carries it. So every field a source may be unable to answer is modelled three ways, never two:

```ts
reminders: Reminder[] | 'none' | 'unknown';
```

`'none'` means the event genuinely has no override and the global lead time applies. `'unknown'` means
this source cannot see the field. Collapsing both into `undefined` leaves the scheduler unable to tell
"fire at the default lead time" from "the source cannot say when to fire", and the second case is one
the user needs telling about.

### Deep links from EventKit

The session poller gets its `eid` free, straight out of the event tuple. EventKit would have to
rebuild it.

Google's `eid` is `base64url("<eventId> <calendarId>")` with padding stripped, and the CalDAV `UID`
that EventKit exposes as `calendarItemExternalIdentifier` is the Google event id with an `@google.com`
suffix. The captured fixture shows the pair directly: `[0]` as `event_id_001_alpha` against `[18]` as
`event_id_001_alpha@google.com`. Stripping the suffix and pairing with the calendar id reconstructs
the same link the poller reads for free.

Recurring series need the occurrence rather than the series. The poller has it directly, since `[55]`
carries the recurrence instance id as `<baseId>_R<YYYYMMDDTHHMMSS>` with the series id at `[13]`.
EventKit gives every occurrence in a series the same `calendarItemExternalIdentifier`, so its resolver
would have to append the occurrence stamp itself. Whether macOS preserves the UID verbatim for every
account type is unverified, and a test has to settle it before EventKit events are advertised as
deep-linkable.

## Bridge

A native CLI binary at `Magical.app/Contents/Resources/bin/eventkit-helper` serves the events:

```bash
eventkit-helper fetch-events --start "2026-09-01" --end "2026-09-30"
```

EventKit is opt-in in Settings (`[x] Include Apple Calendars & Reminders`). Disabled, Magical runs
purely on Google session partitions
([`sessions-and-security.md`'s Multi-partition session sandboxing](../../docs/shared/sessions-and-security.md#multi-partition-session-sandboxing)),
without triggering macOS permission dialogs.
