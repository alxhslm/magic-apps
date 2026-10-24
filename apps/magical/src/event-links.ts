import { allDayLocalDate } from './all-day.js';
import type { NormalizedCalendarEvent } from './calendar-decoder.js';

/**
 * event-links.ts
 *
 * `magical://` links pointing at a specific event, and the resolution back to a Google
 * Calendar URL.
 *
 * Two forms, deliberately. The precise one carries Google's `eid`; the fallback carries
 * only a date. A notification whose `eid` cannot be resolved must still open Magical on
 * the right day for the right account, because a dead link from a banner is worse than a
 * vague one. See `docs/magical/notifications.md#deep-links`.
 */

export const MAGICAL_PROTOCOL = 'magical';

/**
 * What a link asks to be done with the event it names.
 *
 * `reveal` is the default and the only one that asks to look at something; the rest
 * are triage, answered in the account's own view without moving the window. They are
 * the actions a meeting banner offers, reachable without one.
 */
export type EventLinkAction = 'reveal' | 'yes' | 'no' | 'maybe' | 'delete';

const EVENT_LINK_ACTIONS: ReadonlySet<string> = new Set(['reveal', 'yes', 'no', 'maybe', 'delete']);

export interface EventLinkTarget {
  accountId: string;
  /** What to do with the event; opening it is what a link means by default. */
  action: EventLinkAction;
  /** Google's opaque event id, base64url of `<eventId> <calendarId>`. */
  eid?: string;
  /**
   * The day to open.
   *
   * Carried by both forms, not just the fallback: an `eid` names an event but not where
   * it sits, and revealing one means routing to its day before its chip exists to click.
   */
  date?: Date;
}

/**
 * Pulls the `eid` out of an event's web URL.
 *
 * Read rather than constructed: `eid` is base64url of `<eventId> <calendarId>` with
 * padding stripped, and the exact calendar id Google encodes is not always the one on
 * the event tuple. The wire hands us the finished URL, so use it.
 */
export function extractEid(event: NormalizedCalendarEvent): string | undefined {
  // An occurrence of a recurring task is named by the grid rather than by a link.
  if (event.chipEid) return event.chipEid;
  if (!event.webUrl) return undefined;
  try {
    // Read the raw query rather than going through `searchParams`, which decodes `+` as
    // a space. Real eids are base64url so it does not arise today, but a silently
    // mangled eid produces a deep link that opens the wrong thing rather than failing.
    const query = new URL(event.webUrl).search;
    const match = /[?&]eid=([^&]*)/.exec(query);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The two halves an `eid` is built from.
 *
 * An `eid` is base64url of `"<eventId> <calendarId>"`, and a calendar id never contains a
 * space, so the first one separates them. Returns undefined for anything that does not
 * decode to that shape.
 */
export function decodeEid(eid: string): { eventId: string; calendarId: string } | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(eid, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }

  const gap = decoded.indexOf(' ');
  if (gap < 0) return undefined;
  return { eventId: decoded.slice(0, gap), calendarId: decoded.slice(gap + 1) };
}

/**
 * The `eid` for one occurrence of a series, built from the series master's own.
 *
 * An occurrence this app generated inherits the master's `webUrl`, so its `eid` names the
 * series and not the occurrence. Google's grid labels each chip with the occurrence's
 * `eid`, so a link built from the master matches no chip and the reveal lands on the right
 * day with nothing opened -- which is what a banner for a weekly meeting did every time.
 *
 * The calendar id is taken from the master's `eid` rather than from `calendarId`, because
 * it is the one Google itself encoded and it is what the chip will carry.
 *
 * Returns undefined when the master has no readable `eid`, leaving the caller with the
 * master's link: wrong, but no worse than before, and better than a link to nothing.
 */
export function buildOccurrenceEid(
  master: NormalizedCalendarEvent,
  occurrenceId: string,
): string | undefined {
  const masterEid = extractEid(master);
  if (!masterEid) return undefined;

  const parts = decodeEid(masterEid);
  if (!parts) return undefined;
  return Buffer.from(`${occurrenceId} ${parts.calendarId}`, 'utf8').toString('base64url');
}

/** The web URL carrying an `eid`, in the shape the wire uses. */
export function eventUrlForEid(eid: string): string {
  return `https://www.google.com/calendar/event?eid=${encodeURIComponent(eid)}`;
}

/**
 * Builds the most precise link the event supports.
 *
 * The `at` an all-day event carries is the date it is on, written as a local midnight rather
 * than the UTC midnight instant the wire sent. Both readers of it — `resolveToCalendarUrl`
 * here and `AccountsManager.pathForDate` — name the day with local getters, so the raw
 * instant would send a bank holiday to the day before west of UTC. A timed event is an
 * instant and is carried as it is.
 */
export function buildEventLink(event: NormalizedCalendarEvent, accountId: string): string {
  const start = event.isAllDay ? allDayLocalDate(event.startTime) : event.startTime;
  const at = encodeURIComponent(start.toISOString());
  const account = encodeURIComponent(accountId);
  const eid = extractEid(event);
  if (eid) {
    return `${MAGICAL_PROTOCOL}://event?account=${account}&eid=${encodeURIComponent(eid)}&at=${at}`;
  }
  return `${MAGICAL_PROTOCOL}://date?account=${account}&at=${at}`;
}

/** Parses a `magical://` link. Returns null for anything it does not recognise. */
export function parseEventLink(rawUrl: string): EventLinkTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${MAGICAL_PROTOCOL}:`) return null;

  // `magical://event?...` parses with "event" as the host, not the pathname.
  const kind = url.hostname || url.pathname.replace(/^\/+/, '');
  const accountId = url.searchParams.get('account');
  if (!accountId) return null;

  // An unknown action is refused rather than quietly treated as "open it". A link
  // asking for something this build cannot do should do nothing, not something else.
  const requested = url.searchParams.get('action') ?? 'reveal';
  if (!EVENT_LINK_ACTIONS.has(requested)) return null;
  const action = requested as EventLinkAction;

  if (kind === 'event') {
    const eid = url.searchParams.get('eid');
    if (!eid) return null;
    // Older links carry no `at`. They still name the event, so they resolve; they just
    // cannot say which day to route to first.
    const date = parseAt(url.searchParams.get('at'));
    return date ? { accountId, action, eid, date } : { accountId, action, eid };
  }

  if (kind === 'date') {
    // Only an event can be answered or deleted; a day is somewhere to look.
    if (action !== 'reveal') return null;
    const date = parseAt(url.searchParams.get('at'));
    return date ? { accountId, action, date } : null;
  }

  return null;
}

/**
 * The account a `magical://` launch link names, if any.
 *
 * Read before `AccountsManager` exists so a cold launch from a widget, a
 * notification or an external launcher builds its first view for the account the
 * link targets. `event`, `date` and `search` carry `account`; `quick-add` and
 * `open` do not, and a link with no account or an unparseable one leaves the choice
 * to the caller.
 */
export function accountIdFromLink(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${MAGICAL_PROTOCOL}:`) return undefined;
    return url.searchParams.get('account') || undefined;
  } catch {
    return undefined;
  }
}

function parseAt(raw: string | null): Date | undefined {
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * The Google Calendar URL a link should navigate the account's view to.
 *
 * Always a day. `/r/eventedit/<eid>` names the event more precisely and is the wrong
 * place to send anyone: it is the edit form, so a link that failed to open the event
 * would leave the user in an editor they never asked for, one stray keystroke from
 * changing a meeting. Opening the event is the reveal path's job, and when that does
 * not work the honest answer is the day it is on, not a form.
 */
export function resolveToCalendarUrl(target: EventLinkTarget, accountIndex = 0): string {
  const base = `https://calendar.google.com/calendar/u/${accountIndex}/r`;
  const date = target.date ?? new Date();
  return `${base}/day/${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
