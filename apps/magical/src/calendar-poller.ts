import { session } from 'electron';
import { createLogger } from '@magimail/core/logger';
import {
  parsePrefetchEventRangeResponse,
  parseSecondaryCalendarIds,
  CalendarSessionExpiredError,
  CalendarDecodeError,
  CalendarNetworkError,
  CalendarRestrictedError,
  type NormalizedCalendarEvent,
} from './calendar-decoder.js';

const log = createLogger('CalendarPoller');

/**
 * calendar-poller.ts
 *
 * Reads a Google account's calendar through the web client's own transport, using the
 * partition's session cookies. No OAuth, and no incremental sign-in: the user is already
 * authenticated inside the app because the app renders Google Calendar.
 *
 * See `docs/magical/calendar-sync.md`. The wire details here are
 * measured rather than assumed — `docs/magical/calendar-sync.md#zero-oauth-session-mechanism` for
 * the request, `docs/magical/calendar-wire-format.md#range-payload` for what the payload carries.
 *
 * Nothing in this module writes to Google.
 */

const CALENDAR_ORIGIN = 'https://calendar.google.com';

/**
 * Sent because it costs nothing, not because it is required.
 *
 * Measured: the server accepts a nulled or two-year-stale label, so this is not load
 * bearing today. A newly enforced request parameter is one of the two realistic ways
 * this transport breaks, and the canary exists to notice when that changes.
 */
const CLIENT_BUILD_LABEL = 'calendar.web_20260909.10_p0';

/**
 * Trailing client-capability block.
 *
 * Index 6 must be `1`. It is what asks the endpoint to include each recurring series' own
 * occurrence schedule at `IDX.occurrenceList`; with `0` the same request comes back with the rules
 * and the materialised occurrences alone, and every occurrence Google has not placed is simply
 * absent from the answer. Measured against the live endpoint for a work account's 12 calendars:
 * `0` gives 45 masters and no schedule, `1` gives the same 45 masters and 46 schedules. The client
 * shipping this block expands the rules itself; Magical does not, so it has to ask.
 */
const CLIENT_FLAGS = [null, 1, 1, 1, 1, null, 1, 0];

const MS_PER_DAY = 86_400_000;

/**
 * Whether an HTML body is Google's sign-in page rather than a payload.
 *
 * The range endpoint usually answers an expired session with a 401, but an SSO tenant
 * can answer with a redirect to `accounts.google.com` instead, and following it lands on
 * a 200 sign-in page. Reading that as a decode failure would blame the decoder for a
 * session that needs renewing.
 */
function isSignInPage(url: string, text: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'accounts.google.com') return true;
    if (/^\/(ServiceLogin|signin)/i.test(parsed.pathname)) return true;
  } catch {
    // Tests and unusual transports may not report a final URL; the body still can.
  }
  return (
    /id=["']identifierId["']/i.test(text) ||
    /name=["']identifier["']/i.test(text) ||
    /sign in to continue/i.test(text) ||
    /choose an account/i.test(text)
  );
}

/**
 * Whether an HTML body looks like a Workspace administrator's policy block.
 *
 * This is a best-effort recognition, not a measurement: no test tenant has yet produced
 * one. It is deliberately narrow so a sign-in page that mentions Google's privacy policy
 * is not mistaken for an administrator block.
 */
function isPolicyBlockPage(text: string): boolean {
  return (
    /blocked by your administrator/i.test(text) ||
    /your (google workspace )?administrator has (blocked|disabled|restricted)/i.test(text) ||
    /not allowed by (your|the) (organization|administrator)/i.test(text) ||
    /access (is )?denied by (your|the) (organization|administrator)/i.test(text) ||
    /admin_policy|policy_enforced/i.test(text)
  );
}

/**
 * Whether the body is HTML rather than the XSSI-guarded JSON the endpoint normally sends.
 *
 * The content type is not trusted on its own: an intercepted error page can arrive with
 * no headers at all, and the guard prefix is the reliable tell for a payload.
 */
function isHtmlAnswer(text: string, contentType: string | null): boolean {
  if (contentType?.toLowerCase().includes('text/html')) return true;
  if (text.trimStart().startsWith(")]}'")) return false;
  return /^\s*<(!doctype html|html|head|body)\b/i.test(text);
}

/**
 * How a source's last read went.
 *
 * `offline` and `unreadable` are separate because they call for opposite messages.
 * Offline means the request never reached Google, so the calendar is fine and the last
 * good read still describes it. Unreadable means Google answered and the answer could
 * not be used, which is the app being broken. Collapsing the two would tell a user on a
 * train that Magical cannot read their calendar.
 */
export type SourceHealth = 'ok' | 'stale' | 'signed-out' | 'restricted' | 'offline' | 'unreadable';

/** The failure states a single read can end in. */
type ReadFailure = Exclude<SourceHealth, 'ok' | 'stale'>;

/**
 * Which failure a thrown read was.
 *
 * Anything unrecognised is `unreadable` rather than `offline`, because guessing wrong in
 * that direction is the safer error: an outage wrongly called a broken decoder still
 * tells the user something is wrong, where a broken decoder wrongly called an outage
 * tells them to check their wifi for a fault no reconnection will fix.
 */
export function classifyFailure(err: unknown): ReadFailure {
  if (err instanceof CalendarSessionExpiredError) return 'signed-out';
  if (err instanceof CalendarRestrictedError) return 'restricted';
  if (err instanceof CalendarNetworkError) return 'offline';
  return 'unreadable';
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface CalendarPollResult {
  events: NormalizedCalendarEvent[];
  calendarIds: string[];
  fetchedAt: Date;
}

/** Epoch day, as the wire format expresses range bounds. */
export function toEpochDay(date: Date): number {
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / MS_PER_DAY,
  );
}

/**
 * Builds the `sync.prefetcheventrange` body.
 *
 * Two things here are easy to get wrong and were both wrong in the original spec: the
 * calendars are named explicitly rather than inferred from the session, and the range is
 * two scalars rather than a nested pair.
 */
export function buildEventRangeBody(calendarIds: string[], range: DateRange): string {
  const payload = [
    [
      calendarIds,
      [null, null, toEpochDay(range.start), toEpochDay(range.end)],
      [
        null,
        3,
        CLIENT_BUILD_LABEL,
        null,
        null,
        null,
        null,
        978601681,
        null,
        'WEB',
        'prod-00-eu.web',
        1,
        null,
        null,
        null,
        0,
        null,
        '2026c',
        1,
        1,
        null,
        1,
        1,
        null,
        1,
        1,
        1,
      ],
      CLIENT_FLAGS,
    ],
  ];
  return `f.req=${encodeURIComponent(JSON.stringify(payload))}`;
}

export function buildSecondaryCalendarsBody(range: DateRange): string {
  const payload = [
    null,
    [null, null, toEpochDay(range.start), toEpochDay(range.end)],
    CLIENT_FLAGS,
  ];
  return `f.req=${encodeURIComponent(JSON.stringify(payload))}`;
}

export interface CalendarPollerOptions {
  /** Identifies the source to the alert engine and scopes its caches. */
  id: string;
  accountId: string;
  /** Chromium partition holding the account's Google cookies. */
  partition: string;
  /**
   * The account's calendars, as learned by `calendar-identity.ts` and persisted on the
   * account record.
   *
   * Order carries no meaning: an observed request may name only a subscribed calendar
   * and omit the account's own, so this is a set the poller accumulates rather than a
   * ranking. May be empty before the account's view has ever loaded.
   *
   * Deliberately not defaulted. The range endpoint answers an unknown or absent calendar
   * with an empty payload, so a guess would surface as "you have no meetings" rather
   * than as an error — the exact silent failure the alert engine must not have.
   */
  calendarIds: string[];
  /**
   * The account holder's own address, used to find their row in an event's attendee
   * list.
   *
   * Without it the decoder falls back to the wire's own "owns this calendar" flag, which
   * names somebody else on any calendar the account does not own.
   */
  accountEmail?: string;
  /** Google's multi-login index for this account within its partition. Normally 0. */
  accountIndex?: number;
  /** Seam for tests; defaults to the partition's own network stack. */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * One Google account's calendar, as a source the alert engine can consume.
 *
 * Implements the `CalendarEventSource` contract in
 * `docs/magical/calendar-sync.md#source-contract`. The scheduler depends on that
 * interface and never on this class, so the transport stays swappable.
 */
export class CalendarPoller {
  public readonly id: string;
  public readonly accountId: string;
  public readonly kind = 'google-session' as const;

  private readonly partition: string;
  private knownCalendarIds: string[];
  private readonly accountEmail?: string;
  private readonly accountIndex: number;
  private readonly fetchImpl?: CalendarPollerOptions['fetchImpl'];

  private lastSuccessAt: Date | null = null;
  private lastFailure: ReadFailure | null = null;
  private cachedCalendarIds: string[] | null = null;
  private listeners = new Set<() => void>();

  constructor(options: CalendarPollerOptions) {
    this.id = options.id;
    this.accountId = options.accountId;
    this.partition = options.partition;
    this.knownCalendarIds = [...options.calendarIds];
    this.accountEmail = options.accountEmail;
    this.accountIndex = options.accountIndex ?? 0;
    this.fetchImpl = options.fetchImpl;
  }

  public get lastSuccessfulReadAt(): Date | null {
    return this.lastSuccessAt;
  }

  /**
   * Health, never inferred from an empty result.
   *
   * "Signed in with nothing scheduled" and "cannot read your calendar" look identical in
   * the event list and must not look identical here.
   */
  public get health(): SourceHealth {
    if (this.lastFailure) return this.lastFailure;
    if (this.knownCalendarIds.length === 0) return 'unreadable';
    return this.lastSuccessAt ? 'ok' : 'unreadable';
  }

  /**
   * Merges calendars observed from the account's own view into what is already known.
   *
   * A union rather than a replacement, because any single observed request may name a
   * subset: the client asks for one subscribed calendar on its own as readily as it asks
   * for the whole set. Replacing on each observation would drop the account's own
   * calendar the moment the view refreshed a holiday feed.
   */
  /**
   * Replaces the calendars this poller asks for, reporting whether anything moved.
   *
   * Replaces rather than merges, because the set can legitimately shrink: a calendar the
   * account once named in a request but does not subscribe to has to be droppable, and a
   * poller that only ever grew would keep asking for it until the app restarted.
   */
  public setCalendarIds(calendarIds: string[]): boolean {
    const next = calendarIds.filter((id) => id);
    const same =
      next.length === this.knownCalendarIds.length &&
      next.every((id) => this.knownCalendarIds.includes(id));
    if (same) return false;

    this.knownCalendarIds = next;
    this.cachedCalendarIds = null;
    for (const listener of this.listeners) listener();
    return true;
  }

  /** What the poller will ask for, for persistence onto the account record. */
  public getCalendarIds(): string[] {
    return [...this.knownCalendarIds];
  }

  public onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Fetches every calendar on the account for the given range.
   *
   * Throws rather than returning an empty list when the session has expired or the wire
   * format has moved. Callers treat a throw as "tell the user"; they must never treat it
   * as "no events".
   */
  public async events(range: DateRange): Promise<NormalizedCalendarEvent[]> {
    const calendarIds = await this.calendarIds(range);
    const raw = await this.post('sync.prefetcheventrange', buildEventRangeBody(calendarIds, range));

    try {
      const result = parsePrefetchEventRangeResponse(raw, this.accountEmail);
      this.lastSuccessAt = new Date();
      this.lastFailure = null;
      log.info(
        `${this.id}: ${result.events.length} event(s) across ${calendarIds.length} calendar(s)`,
      );
      for (const listener of this.listeners) listener();
      return result.events;
    } catch (err) {
      this.lastFailure = classifyFailure(err);
      throw err;
    }
  }

  /**
   * The account's calendars: its own, plus whatever `secondarycalendars` reports.
   *
   * Cached for the process lifetime. Adding a calendar in Google is rare enough that
   * paying an extra round trip on every poll is not worth it; a restart picks it up.
   */
  private async calendarIds(range: DateRange): Promise<string[]> {
    if (this.cachedCalendarIds) return this.cachedCalendarIds;
    if (this.knownCalendarIds.length === 0) {
      this.lastFailure = 'unreadable';
      throw new CalendarDecodeError(
        `CalendarPoller ${this.id}: no calendar ids known yet. They are learned from the ` +
          `account's own view on first load — see calendar-identity.ts.`,
      );
    }

    let secondary: string[] = [];
    try {
      const raw = await this.post('secondarycalendars', buildSecondaryCalendarsBody(range));
      secondary = parseSecondaryCalendarIds(raw);
    } catch (err) {
      if (err instanceof CalendarSessionExpiredError || err instanceof CalendarNetworkError) {
        this.lastFailure = classifyFailure(err);
        throw err;
      }
      // A degraded but honest result: the primary calendar alone is still worth alerting
      // on, and the failure is recorded rather than swallowed.
      log.warn(`${this.id}: secondary calendar list unavailable:`, err);
    }

    const ids = [...this.knownCalendarIds];
    for (const id of secondary) if (!ids.includes(id)) ids.push(id);
    this.cachedCalendarIds = ids;
    return ids;
  }

  private async post(rpc: string, body: string): Promise<string> {
    const url = `${CALENDAR_ORIGIN}/calendar/u/${this.accountIndex}/${rpc}`;
    const doFetch =
      this.fetchImpl ??
      ((u: string, init: RequestInit) => session.fromPartition(this.partition).fetch(u, init));

    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Is-Xhr-Request': '1',
          'X-If-No-Redirect': '1',
        },
        // Bypass Chromium's HTTP cache on every calendar poll: a POST response cached by
        // the session would cause edits (e.g. all-day → timed) to be invisible until the
        // cached entry expires, which can be minutes after the user made the change.
        cache: 'no-store',
        body,
      });
    } catch (err) {
      // A thrown fetch is a transport failure: no DNS, no route, connection reset. The
      // calendar itself is untouched, so this must not read as "cannot read your
      // calendar" on any surface.
      this.lastFailure = 'offline';
      throw new CalendarNetworkError(`${rpc} could not reach ${CALENDAR_ORIGIN}: ${String(err)}`);
    }

    // The XHR endpoints normally answer an expired session with a clean 401 rather than
    // redirecting to the sign-in page, which is what makes "signed out" separable from
    // "no events".
    if (response.status === 401) {
      this.lastFailure = 'signed-out';
      throw new CalendarSessionExpiredError();
    }

    // A Workspace administrator can refuse Calendar's web endpoints outright. That is
    // neither a sign-in state nor a decoder fault, so it gets its own state and message.
    if (response.status === 403) {
      this.lastFailure = 'restricted';
      throw new CalendarRestrictedError(`${rpc} was refused with HTTP 403`);
    }

    if (!response.ok) {
      this.lastFailure = 'unreadable';
      throw new CalendarDecodeError(`${rpc} returned HTTP ${response.status}`);
    }

    const text = await response.text();
    const contentType = response.headers?.get?.('content-type') ?? null;

    // SSO tenants may redirect a background XHR to the sign-in page and follow it, which
    // arrives as a 200 rather than a 401. Google's policy block page also arrives as HTML
    // and may carry 200, so the two are read apart by what the page says.
    if (isHtmlAnswer(text, contentType)) {
      if (isPolicyBlockPage(text)) {
        this.lastFailure = 'restricted';
        throw new CalendarRestrictedError(`${rpc} was refused by an administrator policy`);
      }
      if (isSignInPage(response.url, text)) {
        this.lastFailure = 'signed-out';
        throw new CalendarSessionExpiredError();
      }
    }

    return text;
  }
}
