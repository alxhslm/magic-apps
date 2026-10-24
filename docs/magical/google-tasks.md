# Google Tasks

Google Calendar's range prefetch (`sync.prefetcheventrange`) surfaces a time-blocked task as a
**focus-time** entry in the primary calendar feed, because Google Tasks materialises the block that
way; `IDX.taskBinding` (61) is what says it is a task. The feed carries no completion state, so
completed and open tasks look identical on it.

To show tasks accurately in the popover and widgets, Magical polls Google Tasks' internal web sync
endpoint and overlays completion state onto the calendar event cache.

## Wire protocol and authentication

- **Endpoint**: `POST https://tasks-pa.clients6.google.com/$rpc/google.internal.tasks.v1.TasksApiService/Sync`
- **Content-Type**: `application/json+protobuf`
- **Authentication**: `Authorization: SAPISIDHASH <timestamp>_<sha1>_u`
  - Preimage: `${gaiaId} ${timestamp} ${sapisid} https://calendar.google.com`
  - Signed with SHA-1 over the active session's `SAPISID` cookie.
  - Unlike Calendar's prefetch, this gRPC-web endpoint rejects requests with HTTP 401 unless
    `SAPISIDHASH` contains the user's Gaia ID.
  - **The request must carry the partition's cookies and an `Origin` header**, so the fetch sets
    `credentials: 'include'` and sends `Origin: https://calendar.google.com`. Electron's
    `session.fetch` runs outside any document, so it sets neither by itself, and Google answers 401
    however well formed the hash is. Measured against the live endpoint: both present returns 200,
    either one omitted returns 401, and the `Referer` header makes no difference.
- **API key**: `X-Goog-Api-Key: <key>`, the key Google's own web client sends on this RPC. It is
  **not a Magic Apps credential and not a secret**: Google serves it to every browser that loads
  Calendar, it is referrer-restricted, and alone it reaches no user data, because the request still
  needs the partition's cookies and a `SAPISIDHASH` signed over the live session. It is read from
  the page rather than committed, so a public, credential-shaped string is not checked into a
  repository about to be published and does not go stale when Google rotates it.
  - **Discovery**: the preload matches the `AIza...` value by shape, in the page's own script tags and
    in the `initialdata` payload. The main process cannot reach the page's `window`, so the key is
    relayed over `CALENDAR_LIST_CHANNEL` alongside the Gaia ID and persisted on the account like it,
    and the poller keeps it current on the next report.
  - **Omitted when unknown**: a poller that has not yet been handed a key sends no
    `X-Goog-Api-Key` header rather than an empty one. The page carries the key as soon as it
    carries the Gaia ID, which the sync already waits for, so the two arrive together in practice.
- **Gaia ID discovery**: extracted from Calendar's `initialdata` payload (indices `[52]` and
  `[0][1]`) or `window.WIZ_global_data?.CTox0e` during calendar list discovery.

## Tuple indices

The response is a JSON-encoded Protocol Buffer array. `response[0]` is a flat run of change records,
each wrapped in a sparse list, and the run holds task lists, recurrence definitions and tasks side by
side:

- `record[0]`: Google Tasks task ID string.
- `record[1]`: Task details tuple.
  - `record[1][0]`: `1` if completed, `null` if open.
  - `record[1][1]`: Title.
  - `record[1][3]`: Due date `[year, month, day]`.
  - `record[1][4]`: Completion timestamp tuple `[secondsString, nanos]`.
  - `record[1][9]`: The recurrence this is an occurrence of, on a recurring task only.
- `record[8]`: Schedule tuple, `[[null, [y, m, d], [h, m], timezone, null, [epochSeconds]]]`.
- `record[23]`: Calendar binding tuple, on a task Google draws on the calendar.
  - `record[23][0][1][0]`: The exact Calendar event ID corresponding to `event.id` in
    `calendar-decoder.ts`.

**Records are matched by shape, not by position.** The wrapper's populated slot moves between
records: measured against a live account, a task sat at index 2 of its wrapper in one response and at
index 5 in another. A task is known by carrying a string id and a details tuple whose title is a
string; a task list carries its own id where a task carries details, and a recurrence definition
carries the list id there, so neither is mistaken for a task.

## Writing a task

Ticking a task off, reopening it and deleting it are the same RPC the read uses —
`TasksApiService/Sync`, with the same `SAPISIDHASH`, API key and cookies — and only the body differs.
`tasks-write.ts` builds that body; `SyncCalendarActionDriver.setTaskCompleted` and the task branch of
its `deleteEvent` post it, and decline to the view for anything they cannot do.

**A write addresses a task by its Tasks id, not by the Calendar event id an `eid` carries.** A
mutation naming the Calendar id answers `200` and changes nothing. Two handles reach the write, and
they resolve differently:

- **`tasks_<Tasks id>`** is what the grid names the chip of a task it draws **nowhere** — a date-only
  one. The handle carries the Tasks id already, so the write strips the prefix and posts the mutation
  with it, and no read happens at all.
- **A task with a time block is the ordinary chip form.** Google materialises the block as a
  focus-time calendar event, so the grid names it `ttb_<base64 of "<event id> <calendar>">` like any
  other event, and its eid decodes to the Calendar event id rather than to a Tasks id. That case is
  the next bullet.
- **Anything else is a Calendar event id**, and the id is resolved from a Tasks sync read first — the
  same read the poller makes — by matching the event against each record's calendar binding. That is
  the read-then-write shape `SyncCalendarActionDriver` already uses for a calendar change, where a
  read refreshes the sync token.

The body is a mutation record carrying a field mask and the fields it sets, and the positional layout
belongs to `tasks-write.ts` rather than here: a completion sets the task's completion state and time,
a reopen clears them, and a delete sets the deleted state and time. Two properties of that message
are load-bearing and easy to get wrong:

- **The record's modified-at has to be current.** A mutation stamped before the task's last change is
  accepted and ignored, so the body is built per action with the clock rather than cached and
  replayed.
- **The list record Google's own client sends is not needed.** The mutation lands with the task
  record alone, for a completion and a delete alike, so the task list's id and its version counter
  are not reconstructed.

**A `200` is not proof the change landed.** The endpoint answers `200` for a mutation it ignored —
exactly what a write naming a Calendar event id gets — so a direct write is confirmed by reading the
task back and by the chip in the account's own view, which draws "Completed" only when Google says so.

## Tasks Google draws nowhere

A task with a date and no time of day is not materialised onto the calendar: the range prefetch
carries nothing for it, and its record in the Tasks sync carries no calendar binding, so nothing in
the read names an event to match it against. The grid still draws it — a chip whose
`data-eventid` is `tasks_<Tasks id>` — and that id is the only handle on it.

`CalendarService.syncTasksCompletion` therefore surfaces every task the read holds with no binding as
an entry of its own: id and `chipEid` both built from the Tasks id, filed under the Tasks calendar,
`isAllDay` when the record carries no time of day, and `fromTasksSync` set like an occurrence. A task
_with_ a binding is skipped there, because the range feed already carries it under the event it is
drawn as and drawing it twice would list it twice. A finished one is drawn as well, exactly as Google
keeps drawing a bound task it is finished with: it greys out, and hiding it is the popover's own
"show completed tasks" setting rather than this pass. Dropping it there instead would take the row
away the moment it was ticked off, leaving the tick with nothing to undo it from.

That is what makes a date-only task completable and deletable: the popover has a row for it, the
write resolves the Tasks id straight out of the chip handle, and the DOM fallback can click the chip
Google draws for it.

## A refusal is paused, not retried

Google answers `403` for an account it will not serve Tasks to, most often one that has never
granted it. That is not a malformed payload and not an expired session, so `TasksPoller` raises a
`TasksRefusedError` rather than the `TasksDecodeError` the decoder uses, and stops asking: the first
refusal pauses the sync for 15 minutes, and each refusal after that doubles the pause up to six
hours. A read that succeeds clears it. `CalendarService.syncTasksCompletion` leaves the cached
completion state alone on any failure, and does not repeat the warning the poller has already logged
once for the episode, so a refused account costs a handful of requests and one line a day instead of
one request and one line per poll. `401` stays the expired-session case, and `429`/`5xx` stay
transient failures that the ordinary poll cadence retries.

## Integration with the event cache and UI

- `CalendarService.syncTasksCompletion` runs after calendar events are expanded; it matches tasks by
  `calendarEventId`, or by the Tasks id an unbound one is filed under, and sets `isCompleted` and
  `completedAt`.
- **Only a task Google draws on the calendar carries a binding.** An occurrence of a recurring task
  carries none, and neither does a one-off task with a date and no time; see
  [Recurring tasks come from the Tasks sync](#recurring-tasks-come-from-the-tasks-sync) and
  [Tasks Google draws nowhere](#tasks-google-draws-nowhere).
- **A sync that answered settles every task event, not only the ones it names.** The response is the
  whole of Google's answer, so a task missing from it is one Tasks does not hold as complete, and
  its cached tick is cleared. A sync that fails leaves the cached state alone, because it is the last
  thing Google actually said. Letting a cached tick survive whatever the sync said cannot work: a
  completion reaches the cache from two places, the optimistic write and the sync, and only the sync
  can retract one, so a task ticked off and then reopened in the browser would stay greyed out across
  restarts.
- **An answer naming none of the account's tasks settles nothing.** Tasks holds a record for an open
  task as much as a finished one, so recognising none of them is a decode that failed rather than an
  account with nothing in it. Settling on it would clear every tick the user has, silently; leaving
  the cached state alone and logging it says so instead.
- Completed tasks are excluded from alert scheduling (`AlertScheduler`), preventing stale
  notifications for finished tasks.
- If the user marks a task complete or incomplete from the context menu (`setTaskCompleted`), Magical
  updates the event cache optimistically and schedules an immediate poll. That write outlives a sync
  that disagrees for 30 seconds: Google Tasks takes a moment to record a completion driven through
  Calendar's own UI, and the poll that follows the click answers in well under a second, so the sync
  is not allowed to settle the write before then. After the window the sync overrules the write like
  any other.
- The `showCompletedTasks` preference controls whether completed tasks appear in the menu bar popover
  and widgets (default: `true`, keeping completed tasks visible and greyed out).

## Recurring tasks come from the Tasks sync

A recurring task appears on Google Calendar's own grid, but not in anything Magical polls as a
calendar. The range prefetch does not carry it: searched for a recurring task's title across a live
account's whole payload, 211 KB on one account and 6.9 MB on another, it is absent from both, while a
one-off task on the same day does arrive, as a focus-time entry naming the task at `IDX.taskBinding`. Google's own web client
draws these from the Tasks service rather than from the event feed.

The Tasks sync carries them already expanded: **one record per occurrence**, each with its own Tasks
id, the shared title, a due date, and a schedule holding the start as epoch seconds. A live account's
monthly task returned 31 of them in one response, covering a month. So there is no recurrence rule to
expand locally, and `calendar-recurrence.ts` is not involved.

`occurrencesInRange` builds an event from each occurrence that falls in the range being fetched, and
`syncTasksCompletion` appends them to what the caller folds into the cache. They are filed under
`tasks@tasks.google.com`, which is what gives them the Tasks calendar's name and colour and lets
hiding that calendar hide them. The start is taken from the epoch seconds rather than rebuilt from
the date and time parts, which would reintroduce every question about the zone they are in; the
`[h, m]` tuple is read only to tell a timed occurrence from a date with no time of day. A timed one is
drawn for an hour, the way Google draws a task.

**The grid names an occurrence's chip by its Tasks id.** There is no Calendar event id and no
`webUrl` to read an `eid` out of, but Google still draws a chip and calls it `tasks_<taskId>`.
Measured on a live account: the occurrence the sync called `mockTaskId0000000001` is the chip
`[data-eventid="tasks_mockTaskId0000000001"]`, beside a one-off task drawn as `ttb_` and the base64 of
`<eventId> <address>`. So the occurrence carries that id in `chipEid`, `extractEid` prefers it, and a
link reaches the occurrence rather than the day it sits on. Everything driven through a chip works
from there, reveal and the completion control alike.

**An occurrence alerts at its own time.** The record says nothing about notifications, so it is given
`reminders: [0]`, which is what a one-off task carries from the calendar wire: a task is due at a
moment rather than starting at one, and the account's global lead would warn some minutes before
that. Nothing else is needed, because an occurrence is an ordinary event to `AlertScheduler` from
there, and `MAX_TIMER_MS` keeps the far ones unarmed until a later poll, exactly as it does for the
occurrences of a recurring meeting.
