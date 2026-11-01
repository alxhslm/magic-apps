/**
 * calendar-decoder.ts
 *
 * Decodes Google Calendar's internal web client wire format
 * (POST https://calendar.google.com/calendar/u/<index>/sync.prefetcheventrange).
 *
 * Google Calendar uses Closure-compiled Protocol Buffers serialized to positional JavaScript arrays
 * prefixed with the standard Google anti-XSSI guard `)]}'\n\n`.
 */

import { createLogger } from '@magimail/core/logger';
import { colourForId } from './google-colours.js';
import { unwrapRedirectors } from './links.js';

export { unwrapRedirectors } from './links.js';

const log = createLogger('CalendarDecoder');

/**
 * Pinned Protocol Buffer field numbers.
 *
 * See `docs/magical/calendar-wire-format.md#pinned-indices` for why these are addressed directly rather
 * than searched for.
 */
export const IDX = {
  id: 0,
  /** `0` on a live event, `2` on a tombstone; see `isTombstone`. */
  status: 1,
  webUrl: 2,
  created: 3,
  updated: 4,
  summary: 5,
  location: 7,
  organizer: 9,
  attendees: 20,
  /**
   * The event's own notification times, present only when it overrides its calendar's.
   *
   * A list of `[method, minutes]`: `[[2,15],[2,5]]` for two notifications, `[[0,10]]`
   * for an email. An event that takes its calendar's default carries nothing here, and so
   * does one whose notifications the user has removed; the two cannot be told apart from
   * this payload.
   */
  reminders: 33,
  recurrence: 12,
  seriesId: 13,
  uid: 18,
  calendar: 34,
  start: 35,
  end: 36,
  syncVersion: 39,
  meetUrl: 45,
  /**
   * The series' recurrence anchor, identical on every occurrence of a series.
   *
   * Named for what it is, because it reads like an instance id usually and is not one: two
   * occurrences of the same weekly meeting, three weeks apart, both carry
   * `<seriesId>_R<firstOccurrence>`. `IDX.id` is what separates occurrences; the wire
   * spells it `<seriesId>_<occurrenceStartUTC>Z`.
   *
   * The same `_R` spelling does also turn up as `IDX.id` itself, on the occurrence an edit
   * anchored a series to; `occurrenceKey` is where the two spellings are reconciled.
   */
  seriesAnchor: 55,
  conference: 57,
  /**
   * The series' own occurrence schedule; see `parseOccurrenceStarts`.
   *
   * A container, not a scalar: the starts live at its slot 11.
   */
  occurrenceList: 63,

  /**
   * The Tasks task this entry is the materialised time block for.
   *
   * Google Tasks draws a task with a time of day by materialising the block as a Calendar
   * focus-time event, so `eventType` reads 7 for it exactly as it does for a focus-time
   * block the user made. This slot is where the two part: its own slot 6 holds the Tasks
   * id for a task, and nothing else. Read that id rather than the slot, which other
   * entries carry too.
   */
  taskBinding: 61,
  /** See `EVENT_TYPE`. */
  eventType: 82,
  /** Present only on a contact birthday, holding that contact's id. */
  contact: 83,
  /**
   * The event label this event has been coloured with, as a uuid.
   *
   * Present only when the event overrides its calendar's colour. The uuid is resolved
   * through the override table beside the calendar blocks; see `readLabelColours`.
   */
  eventLabel: 91,
  description: 64,
} as const;

/**
 * What kind of thing an entry is, which the wire states and a calendar id does not.
 *
 * Tasks and contact birthdays have no block of their own. Asking for
 * `tasks@tasks.google.com` or `birthdays@birthdays.google.com` returns an empty payload
 * even when they are the only calendar named; their entries arrive inside the primary
 * calendar's block, so nothing keyed on a calendar id can tell them apart from an
 * ordinary appointment. This field can.
 *
 * A title heuristic is not a substitute: an ordinary event with "birthday" in its name is
 * `DEFAULT`, and real contact birthdays are not rarer than those.
 */
export const EVENT_TYPE = {
  DEFAULT: 0,
  /** Created from a Gmail message: a flight, a hotel booking, a restaurant reservation. */
  FROM_GMAIL: 1,
  OUT_OF_OFFICE: 3,
  FOCUS_TIME: 7,
  /**
   * A task drawn as a time block, which is a task and not an event kind on this wire.
   *
   * Google Tasks materialises the block as a Calendar focus-time event, so a time-blocked
   * task arrives as `FOCUS_TIME` and never as this. This value is the app's own label for
   * the rows it builds from the Tasks sync, and `IDX.taskBinding` is what marks the
   * materialised block a task. No capture has ever shown Google sending it.
   */
  TASK: 9,
  /**
   * A working location that recurs, as a weekly pattern of home and office days does.
   *
   * The pair below separates a recurring entry from a one-off; neither says which location
   * it is. Measured against a live account: "Home", "Office" and a named office all arrive
   * as `10` when they belong to a series, and as `11` when the user sets one for a single
   * day. Only the title says where the user is.
   */
  WORKING_LOCATION: 10,
  /** A working location set for one day, whether or not a recurring one covers that day. */
  WORKING_LOCATION_ONE_OFF: 11,
  /** A contact's birthday, carrying `IDX.contact`. */
  BIRTHDAY: 13,
} as const;

/**
 * The colour each event label resolves to, from the table beside the calendar blocks.
 *
 * `action[2][2]` is the account's whole set of labels, not just the ones in range:
 * `[null, "<labelId>", <colourId>, …]` per calendar. An event names its label at
 * `IDX.eventLabel`, and nothing in the event tuple carries a colour.
 */
function readLabelColours(payloadBlock: unknown): Map<string, string> {
  const colours = new Map<string, string>();
  const section = Array.isArray(payloadBlock) ? payloadBlock[2] : null;
  if (!Array.isArray(section)) return colours;

  for (const perCalendar of section) {
    if (!Array.isArray(perCalendar) || !Array.isArray(perCalendar[1])) continue;
    for (const entry of perCalendar[1]) {
      if (!Array.isArray(entry)) continue;
      const [, labelId, colourId] = entry;
      const id = typeof colourId === 'number' ? colourId : Number.parseInt(String(colourId), 10);
      if (typeof labelId !== 'string' || !Number.isFinite(id)) continue;
      const hex = colourForId(id);
      if (hex) colours.set(labelId, hex);
    }
  }
  return colours;
}

/**
 * The calendar an entry belongs to when it has arrived inside the primary's block.
 *
 * Google serves neither of these as a calendar of its own, so their entries would
 * otherwise read as ordinary appointments on the account's own calendar: the wrong
 * colour, the wrong name, and out of reach of a filter naming the calendar they belong
 * to.
 */
/**
 * What the grid prefixes a task's chip with: `data-eventid="tasks_<Tasks id>"`.
 *
 * Measured on a live page, and the same for an occurrence of a recurring task and for a
 * date-only task Google draws nowhere: the suffix is the internal Tasks id, which is what
 * makes the chip addressable without a Calendar event behind it.
 */
export const TASK_CHIP_PREFIX = 'tasks_';

/** The calendar a task is filed under, decoded from the wire or built from the sync. */
export const TASKS_CALENDAR_ID = 'tasks@tasks.google.com';

const FOLDED_INTO_PRIMARY: Record<number, string> = {
  [EVENT_TYPE.BIRTHDAY]: 'birthdays@birthdays.google.com',
  [EVENT_TYPE.TASK]: TASKS_CALENDAR_ID,
};

/** Participation states. */
/**
 * How a reminder is delivered, as `IDX.reminders` states it.
 *
 * `EMAIL` rests on a single measured event, which is why nothing silences an alert on the
 * strength of it.
 */
export const REMINDER_EMAIL = 0;
export const REMINDER_NOTIFICATION = 2;

export const RESPONSE_NEEDS_ACTION = 0;
export const RESPONSE_DECLINED = 1;
export const RESPONSE_TENTATIVE = 2;
export const RESPONSE_ACCEPTED = 3;

/**
 * Positions within one attendee entry.
 *
 * `ownsThisCalendar` marks whoever owns the calendar whose block this copy arrived under,
 * which is the public API's `self`. It is not a marker for the signed-in user, though it
 * looks like one for as long as an account is only ever asked for its own calendars: ask
 * for a colleague's too and the copy under their calendar flags them, so reading it as
 * "me" reports their answer as the user's. The account holder's own row is present in
 * every copy, carrying the same response; find it by address.
 *
 * `isOrganiser` is a different flag again, and nothing reads it.
 */
const ATTENDEE = {
  email: 0,
  responseStatus: 5,
  isOrganiser: 8,
  ownsThisCalendar: 9,
} as const;

export interface EventAttendee {
  email: string;
  /** `0` no response, `1` declined, `2` tentative, `3` accepted. */
  responseStatus: number;
  /** True on the row of whoever owns the calendar this copy came under; see `ATTENDEE`. */
  ownsThisCalendar: boolean;
}

/** What a source knows about an event's reminder overrides. */
export type Reminders = number[] | 'none' | 'unknown';

export interface NormalizedCalendarEvent {
  id: string;
  /**
   * Every calendar of the user's that holds this event, in the order the blocks arrived.
   *
   * A consumer needing a single calendar, for a colour or a name, takes the first the
   * user has not hidden. A filter drops the event only when it hides every one of these.
   */
  calendarIds: string[];
  /**
   * The name of the calendar the event lives on, where the wire gave it.
   *
   * Only set from the copy whose block is that calendar; see `parseEventTuple`. It says
   * nothing about the other calendars holding the event, so a consumer looking up a name
   * by calendar id prefers its own table and falls back to this.
   */
  calendarName?: string;
  summary: string;
  webUrl: string;
  /** Null when absent rather than defaulted to now, which would read as a fresh event. */
  created: Date | null;
  updated: Date | null;
  startTime: Date;
  endTime: Date;
  isAllDay: boolean;
  timezone?: string;
  organizerEmail?: string;
  /** Empty when the event has no guests; the wire carries them on ~45% of events. */
  attendees: EventAttendee[];
  /**
   * What kind of entry this is; see `EVENT_TYPE`.
   *
   * Carried rather than inferred from `calendarIds`, which only separates the two kinds
   * that get re-filed. An out-of-office block, a working-location entry and a flight
   * pulled out of Gmail all sit on the account's own calendar and are ordinary events by
   * every other measure.
   */
  eventType: number;
  /**
   * The colour the event itself carries, when it overrides its calendar's.
   *
   * Absent on an event that takes its calendar's colour, which is almost all of them.
   */
  colorHex?: string;
  recurrenceRule?: string;
  /** Exclusion dates (RFC 5545 EXDATE) associated with a recurring series master. */
  recurrenceExceptions?: string[];
  /**
   * The series' occurrence starts, as the wire lists them; see `parseOccurrenceStarts`.
   *
   * Present on a recurring series and on each of its `_R` anchors. This is the schedule the
   * client itself renders from, and the only source of occurrence slots for a series whose
   * master record a "this and following" split has removed.
   */
  occurrenceStarts?: Date[];
  /** True when the event or occurrence was deleted / tombstoned on the wire. */
  isCancelled?: boolean;
  /** Shared by every occurrence of a series. */
  seriesId?: string;
  /**
   * Identifies one occurrence: `<seriesId>_R<YYYYMMDDTHHMMSS>`.
   *
   * Set only on an occurrence this app expanded from a rule. An occurrence the wire
   * returned carries its identity in `id` instead: normally
   * `<seriesId>_<YYYYMMDDTHHMMSS>Z`, but on an edited series' anchor date Google sends one
   * copy whose `id` is this same `_R` spelling. It is never taken from `IDX.seriesAnchor`,
   * which every occurrence of a series shares.
   */
  instanceId?: string;
  uid?: string;
  /**
   * The account holder's own response, read from the attendee list.
   *
   * `'notInvited'` when the user is not an attendee — a personal event, or someone
   * else's meeting on a calendar they can see. That is distinct from "invited and not
   * answered", and conflating the two would badge every event on a shared calendar.
   */
  myResponseStatus: number | 'notInvited';
  location?: string;
  /** HTML. */
  description?: string;
  conferenceUrl?: string;
  reminders: Reminders;
  syncVersion?: string;
  /**
   * True on a task built from the Tasks sync rather than decoded from the calendar wire.
   *
   * An occurrence of a recurring task reaches the app only that way: nothing in the
   * range prefetch corresponds to it, so nothing can be matched against it either.
   */
  fromTasksSync?: boolean;
  /**
   * What Google's grid calls this event's chip, where `webUrl` does not say.
   *
   * An occurrence of a recurring task has no `webUrl` to read an `eid` out of, but the
   * grid still draws a chip for it and names it `tasks_<taskId>`. Measured against a
   * live account: the occurrence the sync called `mockTaskId0000000001` is the chip
   * `[data-eventid="tasks_mockTaskId0000000001"]`.
   */
  chipEid?: string;
  /** Whether a task is complete. Always undefined on non-task events. */
  isCompleted?: boolean;
  /** Timestamp when the task was completed. */
  completedAt?: Date | null;
}

export interface CalendarPrefetchResult {
  syncToken?: string;
  calendars: Array<{
    id: string;
    eventCount: number;
  }>;
  events: NormalizedCalendarEvent[];
}

export class CalendarSessionExpiredError extends Error {
  constructor(message = 'Google Calendar session expired or unauthenticated') {
    super(message);
    this.name = 'CalendarSessionExpiredError';
  }
}

/**
 * Thrown when the request never reached Google.
 *
 * Separate from `CalendarDecodeError` because the two call for opposite responses. A
 * decode failure means the wire format has moved and the app is broken until it is
 * fixed; a network failure means the calendar is fine and unreachable, and the last
 * good read is still worth showing. Telling a user on a train that Magical cannot read
 * their calendar, when the truth is that they have no signal, sends them to the wrong
 * problem.
 */
export class CalendarNetworkError extends Error {
  constructor(message = 'Google Calendar is unreachable') {
    super(message);
    this.name = 'CalendarNetworkError';
  }
}

/**
 * Thrown when Google refuses the range endpoint for this account, rather than because
 * the session expired.
 *
 * A Workspace administrator can block Calendar's web endpoints by policy. That is not a
 * sign-in state: asking the user to sign in again cannot fix it, and it must not read as
 * an empty day. It is separate from `CalendarDecodeError` because the app is not broken
 * either — the tenant is refusing to serve this account.
 */
export class CalendarRestrictedError extends Error {
  constructor(message = 'Google Calendar is restricted for this account') {
    super(message);
    this.name = 'CalendarRestrictedError';
  }
}

/**
 * Strips Google's anti-XSSI guard prefix `)]}'\n\n` or `)]}'` from raw response text.
 */
export function stripXssiGuard(rawText: string): string {
  const trimmed = rawText.trimStart();
  if (trimmed.startsWith(")]}'")) {
    return trimmed.slice(4).trimStart();
  }
  return rawText;
}

/**
 * Checks if the parsed JSON represents an unauthenticated/session-expired error:
 * `[["er", null, null, null, null, 401, ...]]`
 */
export function isUnauthenticatedResponse(data: unknown): boolean {
  if (!Array.isArray(data) || data.length === 0) return false;
  const first = data[0];
  if (!Array.isArray(first) || first.length < 6) return false;
  return first[0] === 'er' && first[5] === 401;
}

/**
 * Parses a timestamp tuple, in either of the two forms Google sends:
 *
 * - `[1789027200000]` — a bare epoch, and **the all-day form**.
 * - `[null, [1789045200000], "Europe/London"]` — zoned, and the timed form.
 *
 * The presence of the timezone is what separates an all-day entry from a timed one;
 * there is no boolean flag for it anywhere in the tuple. It mirrors the public API, where
 * an all-day event carries `start.date` and a timed one carries `start.dateTime` with
 * `start.timeZone`. See `docs/magical/calendar-wire-format.md#event-title-and-times`.
 */
export function parseTimestampTuple(entry: unknown): { date: Date; timezone?: string } | null {
  if (!Array.isArray(entry) || entry.length === 0) return null;

  // Format 1: [epochMs]
  if (typeof entry[0] === 'number') {
    return { date: new Date(entry[0]) };
  }

  // Format 2: [null, [epochMs], timezoneString]
  if (entry[0] === null && Array.isArray(entry[1]) && typeof entry[1][0] === 'number') {
    const tz = typeof entry[2] === 'string' ? entry[2] : undefined;
    return {
      date: new Date(entry[1][0]),
      timezone: tz,
    };
  }

  return null;
}

/**
 * Guards against a pinned index holding something that is not a plausible event date.
 *
 * The window is 1900 to 2100, because a calendar legitimately holds dates far outside a
 * working year: a birthday from Contacts carries the person's year of birth, and one
 * born before the lower bound would throw and take its whole account's payload with it.
 *
 * The narrow window this replaced is the wrong tool for the job it was doing.
 * `parseTimestampTuple` is what rejects a moved index: it demands `[ms]` or
 * `[null, [ms], tz]`, so a string, an id or a bare number never reaches here. This only
 * has to catch a value that is already timestamp-shaped, and for that a century either
 * side of now is as good a bound as a decade while costing no real dates.
 */
function isValidCalendarDate(d: Date): boolean {
  const time = d.getTime();
  return !Number.isNaN(time) && time > -2208988800000 && time < 4102444800000;
}

/**
 * Thrown when a pinned index does not hold what it is supposed to.
 *
 * Deliberately fatal rather than recoverable. The alert engine is built on this
 * decoder, and a banner at the wrong hour is worse than no banner — see
 * `docs/magical/calendar-wire-format.md#pinned-indices`.
 */
export class CalendarDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarDecodeError';
  }
}

/**
 * Join links, matched by path rather than host.
 *
 * A Teams invitation body also carries `teams.microsoft.com/meetingOptions/` and a
 * `dialin.teams.microsoft.com` number; launching either instead of the meeting is worse
 * than offering no button at all.
 */
const JOIN_URL = new RegExp(
  String.raw`https?://[^\s"'<>]*?(?:` +
    String.raw`teams\.microsoft\.com/l/meetup-join/|` +
    String.raw`zoom\.us/(?:j|w)/|` +
    String.raw`webex\.com/(?:meet/|[^\s"'<>]*?j\.php)|` +
    String.raw`meet\.google\.com/` +
    String.raw`)[^\s"'<>&]*`,
  'i',
);

function decodeHtmlEntities(html: string): string {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Scans free text for a joinable meeting URL, after unwrapping redirectors. */
export function findJoinUrlInText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const decoded = decodeHtmlEntities(text);
  for (const candidate of decoded.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    const unwrapped = unwrapRedirectors(candidate.replace(/&amp;/g, '&'));
    if (JOIN_URL.test(unwrapped)) return JOIN_URL.exec(unwrapped)?.[0];
  }
  return undefined;
}

/**
 * Resolves the video join URL, in the order established by measurement:
 * the structured conference block, then the bare Meet field, then the free text.
 */
export function resolveConferenceUrl(tuple: unknown[]): string | undefined {
  const block = tuple[IDX.conference];
  if (Array.isArray(block) && Array.isArray(block[0])) {
    for (const entry of block[0]) {
      // Entry points are [typeCode, uri, …]; 3 is video, 4 and 5 are dial-in.
      if (Array.isArray(entry) && entry[0] === 3 && typeof entry[1] === 'string') return entry[1];
    }
  }
  if (typeof tuple[IDX.meetUrl] === 'string') return tuple[IDX.meetUrl] as string;
  return findJoinUrlInText(readDescription(tuple)) ?? findJoinUrlInText(readLocation(tuple));
}

function readDescription(tuple: unknown[]): string | undefined {
  const d = tuple[IDX.description];
  return Array.isArray(d) && typeof d[1] === 'string' ? d[1] : undefined;
}

function readLocation(tuple: unknown[]): string | undefined {
  return typeof tuple[IDX.location] === 'string' ? (tuple[IDX.location] as string) : undefined;
}

/** The `IDX.status` value the wire uses for a deleted event. */
const TOMBSTONE = 2;

/** The slot inside `IDX.occurrenceList` that holds the starts. */
const OCCURRENCE_LIST_SLOTS = 11;

/**
 * The series' occurrence starts, exactly as the wire lists them.
 *
 * A recurring series carries its own schedule: field 63 holds, at slot 11, one
 * `[stamp, [null, [epoch]]]` per occurrence, hundreds of entries running years ahead. It is what
 * the client itself renders from. It also outlives a "this and following" split that leaves the
 * series with no master tuple and so no rule at all — the case where deriving occurrences from a
 * rule cannot work, because there is no rule left to read. Absent when the field holds something
 * else, such as an override list or a working-location pattern, which do not share the shape.
 */
/**
 * The Tasks id a materialised time-blocked task carries, or null when the entry is not one.
 *
 * The measured shape is `[null, [false, null, null, null, null, null, ["<Tasks id>"]]]`, and
 * the id is what is read rather than the slot: entries that are not tasks carry a non-null
 * slot there too. See `IDX.taskBinding`.
 */
function readTaskBinding(slot: unknown): string | null {
  if (!Array.isArray(slot)) return null;
  const inner = slot[1];
  if (!Array.isArray(inner)) return null;
  const ids = inner[6];
  if (!Array.isArray(ids)) return null;
  return typeof ids[0] === 'string' && ids[0] ? ids[0] : null;
}

function parseOccurrenceStarts(tuple: unknown[]): Date[] | undefined {
  const field = tuple[IDX.occurrenceList];
  if (!Array.isArray(field)) return undefined;
  const slots = field[OCCURRENCE_LIST_SLOTS];
  if (!Array.isArray(slots) || slots.length === 0) return undefined;

  const starts: Date[] = [];
  for (const slot of slots) {
    if (!Array.isArray(slot) || typeof slot[0] !== 'string') return undefined;
    // Two spellings: a timed stamp ending in `Z`, and a bare `YYYYMMDD` for an all-day series
    // such as a weekly working location. The epoch sits directly in the slot's payload for the
    // all-day form and one level deeper for the timed one.
    if (!/^\d{8}(T\d{6}Z)?$/.test(slot[0])) return undefined;
    const inner = slot[1];
    let epoch: number | undefined;
    if (Array.isArray(inner)) {
      const nested = inner[1];
      epoch =
        Array.isArray(nested) && typeof nested[0] === 'number'
          ? nested[0]
          : typeof inner[0] === 'number'
            ? inner[0]
            : undefined;
    }
    const stamp = slot[0].endsWith('Z') ? slot[0].slice(0, -1) : slot[0];
    const start = typeof epoch === 'number' ? new Date(epoch) : parseStampDate(stamp);
    if (Number.isNaN(start.getTime())) return undefined;
    starts.push(start);
  }
  return starts.length > 0 ? starts : undefined;
}

/**
 * Whether the wire is telling us an event was deleted rather than describing one.
 *
 * `IDX.status` is `2` on a tombstone and `0` on a live event. A deletion normally arrives
 * as a short tuple that carries no times, but the same status can ride on a full-length
 * one.
 */
export function isTombstone(tuple: unknown): boolean {
  return (
    Array.isArray(tuple) &&
    tuple.length >= 2 &&
    typeof tuple[IDX.id] === 'string' &&
    tuple[IDX.status] === TOMBSTONE
  );
}

function parseStampDate(stamp: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?$/.exec(stamp);
  if (!m) return new Date(0);
  const [, y, mo, d, h = '00', mi = '00', s = '00'] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

/**
 * Parses a tombstone tuple into a placeholder NormalizedCalendarEvent with `isCancelled: true`.
 * This preserves the slot and series identity for `expandRecurringEvents` so deleted
 * occurrences are never resurrected.
 */
export function parseTombstoneTuple(
  tuple: unknown[],
  blockCalendarId = 'primary',
): NormalizedCalendarEvent | null {
  const id = tuple[IDX.id];
  if (typeof id !== 'string' || !id) return null;

  const match = OCCURRENCE_STAMP.exec(id);
  const stamp = match ? match[1] : null;
  const isAllDay = stamp ? stamp.length === 8 : false;

  let startTime: Date = new Date(0);
  let endTime: Date = new Date(0);

  if (tuple.length >= 37) {
    const start = parseTimestampTuple(tuple[IDX.start]);
    const end = parseTimestampTuple(tuple[IDX.end]);
    if (start && end && isValidCalendarDate(start.date) && isValidCalendarDate(end.date)) {
      startTime = start.date;
      endTime = end.date;
    } else if (stamp) {
      startTime = parseStampDate(stamp);
      endTime = new Date(startTime.getTime() + (isAllDay ? 86_400_000 : 3_600_000));
    }
  } else if (stamp) {
    startTime = parseStampDate(stamp);
    endTime = new Date(startTime.getTime() + (isAllDay ? 86_400_000 : 3_600_000));
  }

  const seriesId =
    typeof tuple[IDX.seriesId] === 'string'
      ? (tuple[IDX.seriesId] as string)
      : match
        ? id.slice(0, match.index)
        : id;

  return {
    id,
    calendarIds: [blockCalendarId],
    summary: typeof tuple[IDX.summary] === 'string' ? (tuple[IDX.summary] as string) : '',
    webUrl: '',
    created: null,
    updated: null,
    startTime,
    endTime,
    isAllDay,
    attendees: [],
    eventType: EVENT_TYPE.DEFAULT,
    seriesId,
    // The uid is what `occurrenceKey` folds a tombstone and a live copy of the same
    // occurrence together on. Without it a tombstone keys on its id while the live copy
    // keys on its uid, so they never merge and the deleted slot comes back.
    uid: typeof tuple[IDX.uid] === 'string' ? (tuple[IDX.uid] as string) : undefined,
    myResponseStatus: 'notInvited',
    reminders: 'none',
    isCancelled: true,
  };
}

/**
 * Parses an individual event tuple, as the copy under one calendar's block.
 *
 * `calendarIds` holds that one calendar; an event held by several arrives once under each,
 * and `parsePrefetchEventRangeResponse` is what gathers the copies into one event.
 *
 * Indices are pinned, never searched for. They are Protocol Buffer field numbers, which
 * Google cannot renumber without breaking its own rolling deployments; scanning for a
 * field by shape defends against a failure mode that does not occur, and risks matching
 * the wrong one. Returns null only for entries that are not events at all.
 */
export function parseEventTuple(
  tuple: unknown,
  blockCalendarId = 'primary',
  accountEmail?: string,
  labelColours?: ReadonlyMap<string, string>,
  includeTombstones = false,
): NormalizedCalendarEvent | null {
  let calendarId = blockCalendarId;
  if (!Array.isArray(tuple)) return null;

  // A deletion of an occurrence normally arrives as a short tuple, but a full-length
  // tuple can carry the same status. When includeTombstones is enabled, return a cancelled
  // placeholder event so recurrence expansion does not re-synthesize the cancelled slot.
  if (isTombstone(tuple)) {
    return includeTombstones ? parseTombstoneTuple(tuple, blockCalendarId) : null;
  }

  if (tuple.length < 37) return null;

  const id = tuple[IDX.id];
  if (typeof id !== 'string' || !id) {
    throw new CalendarDecodeError(
      `Event has no valid id at [${IDX.id}] — the wire format has moved`,
    );
  }

  const start = parseTimestampTuple(tuple[IDX.start]);
  const end = parseTimestampTuple(tuple[IDX.end]);
  if (!start || !end || !isValidCalendarDate(start.date) || !isValidCalendarDate(end.date)) {
    throw new CalendarDecodeError(
      `Event ${id}: no valid start/end at [${IDX.start}]/[${IDX.end}] — the wire format has moved`,
    );
  }

  const createdMs = typeof tuple[IDX.created] === 'number' ? (tuple[IDX.created] as number) : null;
  const updatedMs = typeof tuple[IDX.updated] === 'number' ? (tuple[IDX.updated] as number) : null;

  // The calendar a copy sits on is the block it came back under, not `IDX.calendar`.
  //
  // `IDX.calendar` names the calendar holding the event's canonical copy, which for an
  // invitation is the organiser's. Read as "this event's calendar" it gives every
  // invitation a calendar the user does not have, so nothing keyed by calendar id can
  // match: not the colour, not the name, not the popover's hidden-calendar filter.
  //
  // Tasks and contact birthdays arrive inside the primary calendar's block, because
  // neither has a block of its own. They replace it rather than joining it: a birthday
  // is on the Birthdays calendar and not on the primary at all, so leaving the primary in
  // the list would take the primary's colour and name and keep the entry on screen after
  // the user hides Birthdays. `IDX.eventType` is what separates them; no calendar id in
  // the response does.
  //
  // A time-blocked task is a focus-time event on this wire, so the type alone cannot tell
  // it from a focus-time block the user made; the Tasks id at `IDX.taskBinding` is what
  // does, and it is read first for that reason.
  const isTaskBlock = readTaskBinding(tuple[IDX.taskBinding]) !== null;
  const eventType = isTaskBlock
    ? EVENT_TYPE.TASK
    : typeof tuple[IDX.eventType] === 'number'
      ? (tuple[IDX.eventType] as number)
      : undefined;
  const foldedInto = FOLDED_INTO_PRIMARY[eventType ?? -1];
  if (foldedInto) calendarId = foldedInto;

  const label = tuple[IDX.eventLabel];
  const colorHex = typeof label === 'string' ? labelColours?.get(label) : undefined;

  const calendarMeta = tuple[IDX.calendar];
  const sourceCalendarId =
    Array.isArray(calendarMeta) && typeof calendarMeta[0] === 'string'
      ? calendarMeta[0]
      : undefined;
  const calendarName =
    sourceCalendarId === calendarId &&
    Array.isArray(calendarMeta) &&
    typeof calendarMeta[1] === 'string'
      ? calendarMeta[1]
      : undefined;

  const attendees: EventAttendee[] = [];
  const rawAttendees = tuple[IDX.attendees];
  if (Array.isArray(rawAttendees)) {
    for (const entry of rawAttendees) {
      const email = entry?.[ATTENDEE.email];
      if (!Array.isArray(entry) || typeof email !== 'string' || !email.includes('@')) continue;
      attendees.push({
        email,
        responseStatus:
          typeof entry[ATTENDEE.responseStatus] === 'number' ? entry[ATTENDEE.responseStatus] : 0,
        ownsThisCalendar: entry[ATTENDEE.ownsThisCalendar] === true,
      });
    }
  }

  const organizer = tuple[IDX.organizer];
  const organizerEmail =
    Array.isArray(organizer) && typeof organizer[0] === 'string' ? organizer[0] : undefined;

  const rawRecurrence = tuple[IDX.recurrence];
  let recurrenceRule: string | undefined;
  const recurrenceExceptions: string[] = [];
  const occurrenceStarts = parseOccurrenceStarts(tuple);
  if (Array.isArray(rawRecurrence)) {
    for (const item of rawRecurrence) {
      if (typeof item === 'string') {
        if (item.startsWith('RRULE:')) {
          recurrenceRule ??= item;
        } else if (item.startsWith('EXDATE:') || item.startsWith('EXDATE;')) {
          recurrenceExceptions.push(item);
        }
      }
    }
  }

  // Only the notification entries: an email reminder is not something this app can
  // deliver, and the alert engine would treat its minutes as a banner time.
  //
  // An event carrying overrides but no notification among them falls back to the global
  // lead rather than going silent. Silencing would rest entirely on `REMINDER_EMAIL`,
  // which one live event established; getting that wrong loses alerts, and the cost of
  // being wrong the other way is an alert the user might not have asked for.
  const rawReminders = tuple[IDX.reminders];
  const reminderMinutes = Array.isArray(rawReminders)
    ? rawReminders
        .filter(
          (r): r is [number, number] =>
            Array.isArray(r) && r[0] === REMINDER_NOTIFICATION && typeof r[1] === 'number',
        )
        .map((r) => r[1])
    : [];

  // The account holder's own response is on the attendee list, and nowhere else. One
  // neighbouring field reads like a participation status and is not: its values scatter
  // across every attendee state, accepted, unanswered and not-invited alike.
  //
  // Found by address, because `ownsThisCalendar` answers a different question: it flags
  // whoever owns the calendar this copy came under. An event on a colleague's calendar
  // flags the colleague, and reading that would report their answer as the user's. The
  // user's own row is present in every copy of an event, carrying the same response.
  //
  // Without an address to look for, the flag is the best available guess and is right
  // whenever the block is the account's own calendar.
  const self = accountEmail
    ? attendees.find((a) => a.email === accountEmail)
    : attendees.find((a) => a.ownsThisCalendar);
  const myResponseStatus: number | 'notInvited' = self ? self.responseStatus : 'notInvited';

  return {
    id,
    calendarIds: [calendarId],
    calendarName,
    summary: typeof tuple[IDX.summary] === 'string' ? (tuple[IDX.summary] as string) : '',
    webUrl: typeof tuple[IDX.webUrl] === 'string' ? (tuple[IDX.webUrl] as string) : '',
    created: createdMs === null ? null : new Date(createdMs),
    updated: updatedMs === null ? null : new Date(updatedMs),
    startTime: start.date,
    endTime: end.date,
    isAllDay: start.timezone === undefined,
    timezone: start.timezone ?? end.timezone,
    organizerEmail,
    attendees,
    eventType: eventType ?? EVENT_TYPE.DEFAULT,
    ...(colorHex ? { colorHex } : {}),
    recurrenceRule,
    recurrenceExceptions: recurrenceExceptions.length > 0 ? recurrenceExceptions : undefined,
    ...(occurrenceStarts ? { occurrenceStarts } : {}),
    seriesId:
      typeof tuple[IDX.seriesId] === 'string'
        ? (tuple[IDX.seriesId] as string)
        : OCCURRENCE_STAMP.exec(id)
          ? id.slice(0, OCCURRENCE_STAMP.exec(id)!.index)
          : undefined,
    uid: typeof tuple[IDX.uid] === 'string' ? (tuple[IDX.uid] as string) : undefined,
    myResponseStatus,
    location: readLocation(tuple),
    description: readDescription(tuple),
    conferenceUrl: resolveConferenceUrl(tuple),
    // `'unknown'` covers both an event that takes its calendar's default and one whose
    // notifications have been removed; `IDX.reminders` is absent either way, and the calendar's
    // own default is not in this payload at all.
    reminders: reminderMinutes.length > 0 ? reminderMinutes : 'unknown',
    syncVersion:
      typeof tuple[IDX.syncVersion] === 'string' ? (tuple[IDX.syncVersion] as string) : undefined,
  };
}

/**
 * The occurrence a wire id names, with the `_R` recurrence spelling and the `Z` dropped:
 * `20260925T084000` for a timed occurrence and `20260918` for an all-day one.
 */
const OCCURRENCE_STAMP = /_R?(\d{8}(?:T\d{6})?)Z?$/;

/**
 * Whether an id is the `_R` recurrence spelling rather than the materialised one.
 *
 * The trailing `Z` is optional: the wire spells the recurrence id without it, but the two
 * regexes that read the same id for its slot (`OCCURRENCE_STAMP`, and `MATERIALISED_ID` in
 * `calendar-recurrence.ts`) tolerate it, so an id spelled that way has to be recognised here too.
 */
const RECURRENCE_ID = /_R\d{8}(?:T\d{6})?Z?$/;

/**
 * The meeting and occurrence an event is a copy of, for folding the copies together.
 *
 * A wire id will not do as the key. After a series is edited Google returns an occurrence
 * twice, once as `<seriesId>_<slotUTC>Z` and once as the series' recurrence id
 * `<seriesId>_R<slotUTC>` (see `IDX.seriesAnchor`); the two ids name one occurrence, and
 * keyed by id they stand as two in the agenda.
 *
 * The occurrence is named by the stamp in the id rather than by `startTime`, which is not
 * the same thing: a moved occurrence keeps the stamp of the slot its series placed it at while
 * `startTime` holds the time the user dragged it to, so the two copies of one moved
 * occurrence do not even start together. The stamp is the same on both spellings. An
 * event whose id carries no stamp — a master, whose id is the series id alone — falls back
 * to its start. `uid` names the event, and recurrences of a series share it but never a
 * slot; an event with no uid falls back to its id.
 *
 * The uid does not name a series on its own. A "this and following" split can carry one
 * iCalendar uid across both halves, and their occurrences meet at the split slot, so the old
 * series' truncation tombstone and the replacement's first occurrence would key alike and the
 * deletion would fold the live occurrence away. The series id keeps the two apart; an event
 * with no series id falls back to its own id, which is the series id for a master.
 *
 * The rule flag keeps a master and a materialised instance apart even when their slots
 * coincide: the master carries the series and the instance one occurrence, and folding
 * them would drop the rule.
 */
function occurrenceKey(event: NormalizedCalendarEvent): string {
  const kind = event.recurrenceRule ? 'master' : 'instance';
  const stamp = OCCURRENCE_STAMP.exec(event.id);
  const slot = stamp ? stamp[1] : String(event.startTime.getTime());
  const series = event.seriesId ?? event.id;
  return `${event.uid ?? event.id}\u0000${series}\u0000${slot}\u0000${kind}`;
}

/**
 * Parses the complete response from `POST /calendar/u/<index>/sync.prefetcheventrange`.
 *
 * Expected payload shape:
 * [
 *   [
 *     "prefetcheventrangeaction.perr",
 *     0,
 *     [
 *       "<syncTokenBlob>",
 *       [
 *         [ "<calendarId>", [ [event1...], [event2...] ] ]
 *       ]
 *     ]
 *   ]
 * ]
 */
export function parsePrefetchEventRangeResponse(
  rawText: string,
  accountEmail?: string,
): CalendarPrefetchResult {
  const jsonText = stripXssiGuard(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Failed to parse Google Calendar JSON: ${(err as Error).message}`);
  }

  if (isUnauthenticatedResponse(parsed)) {
    throw new CalendarSessionExpiredError();
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { events: [], calendars: [] };
  }

  const actionBlock = parsed[0];
  if (!Array.isArray(actionBlock) || actionBlock[0] !== 'prefetcheventrangeaction.perr') {
    return { events: [], calendars: [] };
  }

  const payloadBlock = actionBlock[2];
  if (!Array.isArray(payloadBlock) || payloadBlock.length < 2) {
    return { events: [], calendars: [] };
  }

  const syncToken = typeof payloadBlock[0] === 'string' ? payloadBlock[0] : undefined;
  const labelColours = readLabelColours(payloadBlock);
  const calendarsBlock = payloadBlock[1];

  if (!Array.isArray(calendarsBlock)) {
    return { syncToken, events: [], calendars: [] };
  }

  const calendars: Array<{ id: string; eventCount: number }> = [];
  // Keyed by `occurrenceKey`, because one event arrives once per calendar that holds it,
  // and an edited series' anchor occurrence arrives twice under two ids in one calendar.
  //
  // One event object per meeting, never one per copy. Two objects for the same meeting
  // would arm its alert twice and count it twice in the Dock badge. Only the calendars are
  // plural: the copies agree on everything else worth keeping, since the account holder's
  // own response is found by address and so reads the same in every one of them.
  const merged = new Map<string, NormalizedCalendarEvent>();
  let copies = 0;

  // A calendar block is `[id, [event, …], [null, null, startDay, endDay], accessRole]`. It carries
  // the range that was asked for and nothing else about the calendar; no name, and no
  // colour.
  for (const calEntry of calendarsBlock) {
    if (!Array.isArray(calEntry) || typeof calEntry[0] !== 'string') continue;
    const calId = calEntry[0];
    const eventEntries = Array.isArray(calEntry[1]) ? calEntry[1] : [];

    let count = 0;
    for (const evtTuple of eventEntries) {
      let decoded: NormalizedCalendarEvent | null;
      try {
        decoded = parseEventTuple(evtTuple, calId, accountEmail, labelColours, true);
      } catch (err) {
        if (err instanceof CalendarDecodeError) throw err;
        throw new CalendarDecodeError(
          `Event in ${calId} failed to decode: ${(err as Error).message}`,
        );
      }
      if (!decoded) continue;
      count++;
      copies++;

      const mergedKey = occurrenceKey(decoded);
      const held = merged.get(mergedKey);
      if (!held) {
        merged.set(mergedKey, decoded);
        continue;
      }

      // If one copy is marked cancelled, the deletion wins over any live copy of the occurrence.
      if (held.isCancelled || decoded.isCancelled) {
        const tombstone = decoded.isCancelled ? decoded : held;
        const other = tombstone === decoded ? held : decoded;
        for (const id of other.calendarIds) {
          if (!tombstone.calendarIds.includes(id)) tombstone.calendarIds.push(id);
        }
        merged.set(mergedKey, tombstone);
        continue;
      }

      // Keep the copy the wire materialised over the `_R` spelling of the same
      // occurrence: on a moved occurrence the materialised id carries the move and the
      // recurrence copy still holds the slot it came from.
      const winner =
        !RECURRENCE_ID.test(decoded.id) && RECURRENCE_ID.test(held.id) ? decoded : held;
      const other = winner === held ? decoded : held;
      for (const id of other.calendarIds) {
        if (!winner.calendarIds.includes(id)) winner.calendarIds.push(id);
      }
      // The name belongs to the calendar the event lives on, and only the copy under
      // that calendar carries it, which may not be the first copy to arrive.
      winner.calendarName ??= other.calendarName;
      // A series lists its own occurrence starts on one copy, usually the `_R` anchor the
      // materialised copy wins over. The schedule belongs to the series, not the occurrence, so
      // it has to survive whichever copy wins: losing it with the loser left a series whose
      // master a split removed with no rule and no schedule — no occurrences at all.
      if (other.occurrenceStarts && other.occurrenceStarts.length > 0) {
        winner.occurrenceStarts = [...(winner.occurrenceStarts ?? []), ...other.occurrenceStarts];
      }
      // Each copy's link carries an `eid` naming its own calendar, and the chip Google
      // draws for the user carries the one for the calendar they see it under. Taking
      // the account's own copy keeps a link that can find its chip, rather than leaving
      // it to whichever calendar the response happened to list first.
      if (accountEmail && calId === accountEmail && decoded.webUrl) {
        winner.webUrl = decoded.webUrl;
      } else if (winner !== held && held.webUrl) {
        winner.webUrl = held.webUrl;
      }
      merged.set(mergedKey, winner);
    }

    calendars.push({ id: calId, eventCount: count });
  }

  const events = [...merged.values()];
  log.info(
    `Decoded ${events.length} event(s) across ${calendars.length} calendar(s)` +
      (copies > events.length ? `, from ${copies} copies` : ''),
  );

  return {
    syncToken,
    calendars,
    events,
  };
}

/**
 * Parses `POST /calendar/u/<index>/secondarycalendars`.
 *
 * The range endpoints will not infer calendars from the session — an empty or null list
 * returns an empty payload — so the poller has to name every calendar explicitly. This
 * endpoint supplies the secondary, subscribed and imported ones. It does **not** return
 * the account's own primary calendar; that id has to come from the account record.
 */
export function parseSecondaryCalendarIds(rawText: string): string[] {
  const parsed: unknown = JSON.parse(stripXssiGuard(rawText));
  if (isUnauthenticatedResponse(parsed)) throw new CalendarSessionExpiredError();
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) return [];

  const action = parsed[0];
  if (action[0] !== 'secondarycalendarsaction.sar') return [];

  const payload = action[2];
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) return [];

  const ids = new Set<string>();
  for (const entry of payload[1]) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0]) ids.add(entry[0]);
  }
  return [...ids];
}
