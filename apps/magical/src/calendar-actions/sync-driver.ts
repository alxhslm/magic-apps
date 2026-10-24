import { session } from 'electron';
import type { WebContentsView } from 'electron';
import { createLogger } from '@magimail/core/logger';
import { decodeEid } from '../event-links.js';
import { syncStateFor, type SyncState } from '../calendar-sync-state.js';
import { taskIdFromChip, writeTaskMutation, type TaskMutation } from './tasks-write.js';
import type {
  CalendarActionDriver,
  CalendarActionOutcome,
  RsvpResponse,
  RsvpTiming,
} from './types.js';

const log = createLogger('SyncCalendarActionDriver');

const CALENDAR_ORIGIN = 'https://calendar.google.com';

/**
 * Where a change writes its payload in the event delta's positional field block.
 *
 * These are the *write* message's field numbers, not the read decoder's `IDX`: a delete
 * lands on 20 and an attendee response on 41, counted from the captures in
 * `docs/magical/actions.md`. They were measured, not derived, and a wrong slot is a
 * silent no-op rather than an error.
 */
const DELETE_FIELD = 20;
const RSVP_FIELD = 41;

/** Response enum, matching `calendar-decoder.ts`'s `RESPONSE_*` constants. */
const RESPONSE_DECLINED = 1;
const RESPONSE_TENTATIVE = 2;
const RESPONSE_ACCEPTED = 3;

/**
 * The change sequence numbers the client increments per change and per sync round.
 *
 * The server orders changes by them but does not require them to be current: a captured
 * write replayed with its stale numbers still landed. They are kept
 * non-decreasing within a process rather than rebuilt from the read state.
 */
let sequence = 0;
function nextSequence(): number {
  sequence += 1;
  return sequence;
}

export interface SyncDriverAccountContext {
  id: string;
  partition: string;
  accountIndex?: number;
  gaiaId?: string;
  apiKey?: string;
  /** The account's own address. Google's primary-calendar eid is truncated, this is not. */
  email?: string;
}

export interface SyncCalendarActionDriverOptions {
  getAccountContext: (accountId: string) => SyncDriverAccountContext | undefined;
  /** Test seams: a Tasks write without a live partition. */
  tasksFetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  getTasksSapisidImpl?: () => Promise<string | null>;
}

interface SyncResponse {
  status: number;
  text: string;
}

/**
 * Direct calendar writes over Google's internal `sync.sync` endpoint.
 *
 * The endpoint is the same one the web client uses for delta reads: read and write are
 * separated only by the change slot. A write needs a current sync token, so each action
 * is a read (no changes) to obtain one, then a write (the change) against it. There is no
 * `SAPISIDHASH` and no API key — the partition's cookies authenticate it — but the
 * trailing `cwuik/hl/secid` are required, so they come from the captured request.
 *
 * Every action falls back to the DOM driver when this fails, so a `failed` here is not a
 * dropped action; it is a decision to drive the view instead.
 */
export class SyncCalendarActionDriver implements CalendarActionDriver {
  constructor(private readonly options: SyncCalendarActionDriverOptions) {}

  public async performRsvp(
    _view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    response: RsvpResponse,
    startTime: Date,
    timing?: RsvpTiming,
  ): Promise<CalendarActionOutcome> {
    const account = this.options.getAccountContext(accountId);
    if (!account) {
      log.warn(`Account ${accountId} not found for sync RSVP`);
      return 'failed';
    }

    const decoded = decodeEid(eid);
    if (!decoded) {
      log.warn(`Cannot decode eid ${eid} for RSVP`);
      return 'failed';
    }

    // The write's attendee block carries the occurrence's own times, which only the
    // banner path knows. Without them the change cannot be built, so the view drives it.
    const endTime = timing?.endTime;
    const timezone = timing?.timezone;
    if (!endTime || !timezone) {
      log.info(`No end time or zone for ${decoded.eventId}; RSVP cannot go direct`);
      return 'failed';
    }

    const code =
      response === 'yes'
        ? RESPONSE_ACCEPTED
        : response === 'no'
          ? RESPONSE_DECLINED
          : RESPONSE_TENTATIVE;
    const change = buildRsvpChange(
      decoded.eventId,
      resolveCalendarId(decoded.calendarId, account),
      code,
      startTime.getTime(),
      endTime.getTime(),
      timezone,
    );

    const outcome = await this.writeChange(account.partition, change, 'RSVP');
    return outcome;
  }

  public async deleteEvent(
    _view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    _startTime: Date,
    isTask = false,
  ): Promise<CalendarActionOutcome> {
    // A task is not a calendar event: its delete is a Tasks mutation, not the calendar
    // change built below. A calendar change naming a task id is accepted and does nothing.
    if (isTask) {
      return this.writeTask(accountId, eid, 'delete');
    }

    const account = this.options.getAccountContext(accountId);
    if (!account) {
      log.warn(`Account ${accountId} not found for sync delete`);
      return 'failed';
    }

    const decoded = decodeEid(eid);
    if (!decoded) {
      log.warn(`Cannot decode eid ${eid} for deletion`);
      return 'failed';
    }

    const change = buildDeleteChange(
      decoded.eventId,
      resolveCalendarId(decoded.calendarId, account),
    );
    return this.writeChange(account.partition, change, 'delete');
  }

  /**
   * Ticks a task off, or back open, through Google Tasks' own sync write.
   *
   * The write addresses the task by its Tasks id, which the eid does not carry, so
   * `writeTaskMutation` resolves it from a Tasks read first. Anything it cannot do
   * returns `failed`, and the fallback driver drives the view instead.
   */
  public async setTaskCompleted(
    _view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    _startTime: Date,
    completed: boolean,
  ): Promise<CalendarActionOutcome> {
    return this.writeTask(accountId, eid, completed ? 'complete' : 'reopen');
  }

  /**
   * One direct Tasks write, resolved from an eid to the task behind it.
   *
   * The eid names the Calendar event the task is drawn as; a write naming that event id
   * instead of the Tasks id answers `200` and changes nothing, so the id is resolved
   * rather than passed through.
   */
  private async writeTask(
    accountId: string,
    eid: string,
    mutation: TaskMutation,
  ): Promise<CalendarActionOutcome> {
    const account = this.options.getAccountContext(accountId);
    if (!account) {
      log.warn(`Account ${accountId} not found for task ${mutation}`);
      return 'failed';
    }
    if (!account.gaiaId) {
      log.info(`No Gaia ID for ${accountId}; task ${mutation} cannot go direct`);
      return 'failed';
    }

    // Two handles reach here. A task Google draws nowhere is named by the grid as
    // `tasks_<Tasks id>`, which carries the id already; anything else is a Calendar event
    // id, which the write resolves through the task's binding in the read.
    const handle = taskIdFromChip(eid) ? eid : decodeEid(eid)?.eventId;
    if (!handle) {
      log.info(`Cannot decode eid ${eid} for task ${mutation}`);
      return 'failed';
    }

    // No `X-Goog-AuthUser` beyond the default: every Magical account has its own
    // partition with one Google session in it, so each is `u/0` — which is what the
    // Tasks poller sends and what its reads answer for every account.
    const written = await writeTaskMutation(
      {
        partition: account.partition,
        gaiaId: account.gaiaId,
        apiKey: account.apiKey,
        fetchImpl: this.options.tasksFetchImpl,
        getSapisidImpl: this.options.getTasksSapisidImpl,
      },
      handle,
      mutation,
    );
    return written ? 'ok' : 'failed';
  }

  /**
   * One direct write: read a fresh token, then post the change against it.
   */
  private async writeChange(
    partition: string,
    change: unknown[],
    label: string,
  ): Promise<CalendarActionOutcome> {
    const state = syncStateFor(partition);
    if (!state) {
      log.info(`No captured sync.sync state for ${partition}; ${label} cannot go direct`);
      return 'failed';
    }

    try {
      const token = await this.readToken(partition, state);
      if (!token) {
        log.warn(`No fresh sync token for ${partition}; ${label} cannot go direct`);
        return 'failed';
      }

      const envelope = clone(state.envelope);
      const top = envelope[0] as unknown[];
      top[1] = token;
      top[4] = [change];

      const result = await this.post(partition, state, envelope);
      if (result === null) return 'failed';

      if (result.status !== 200 || isErrorResponse(result.text)) {
        log.warn(`${label} via sync.sync returned HTTP ${result.status}`);
        return 'failed';
      }

      log.info(`${label} via sync.sync accepted`);
      return 'ok';
    } catch (err) {
      log.warn(`${label} via sync.sync threw: ${err}`);
      return 'failed';
    }
  }

  /**
   * The sync token a write depends on, refreshed by a read.
   *
   * The captured request's own token is tried first; a read with it returns the next
   * token. A null token is the fallback, and answers with a full sync rather than a
   * delta, which is heavier but always current.
   */
  private async readToken(partition: string, state: SyncState): Promise<string | null> {
    const captured = (state.envelope[0] as unknown[])[1];

    for (const token of [captured, null]) {
      const envelope = clone(state.envelope);
      const top = envelope[0] as unknown[];
      top[1] = token;
      top[4] = null;

      const result = await this.post(partition, state, envelope);
      if (!result) continue;
      const fresh = extractToken(result.text);
      log.debug(
        `read for ${partition}: status ${result.status} token ${fresh ? fresh.length : 0}b`,
      );
      if (fresh) return fresh;
    }

    return null;
  }

  private async post(
    partition: string,
    state: SyncState,
    envelope: unknown[],
  ): Promise<SyncResponse | null> {
    const body = `f.req=${encodeURIComponent(JSON.stringify(envelope))}&${state.params}`;
    const ses = session.fromPartition(partition);
    const response = await ses.fetch(state.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Is-Xhr-Request': '1',
        'X-If-No-Redirect': '1',
        Origin: CALENDAR_ORIGIN,
      },
      cache: 'no-store',
      body,
    });
    return { status: response.status, text: await response.text() };
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * The calendar a change names.
 *
 * Google spells the primary calendar's calendar id in an eid as a short form —
 * `user@m`, measured — while the id every endpoint accepts is the account's own
 * address. A secondary calendar's eid carries the full id, so the short form is the
 * test: a domain with no dot is the primary and the account's address replaces it.
 */
export function resolveCalendarId(calendarId: string, account: SyncDriverAccountContext): string {
  if (account.email && !/\.[A-Za-z]{2,}$/.test(calendarId)) return account.email;
  return calendarId;
}

function stripXssiGuard(text: string): string {
  return text.replace(/^\)\]\}'\s*/, '');
}

/** The next sync token, from the response's own slot, with a shape fallback. */
export function extractToken(text: string): string | null {
  try {
    const json: unknown = JSON.parse(stripXssiGuard(text));
    const first = Array.isArray(json) ? json[0] : undefined;
    const slot = first && Array.isArray(first) && Array.isArray(first[2]) ? first[2][1] : undefined;
    const token = Array.isArray(slot) ? slot[0] : undefined;
    if (typeof token === 'string' && token.length > 40) return token;
  } catch {
    // Fall through to the shape scan.
  }

  const match = stripXssiGuard(text).match(/[A-Za-z0-9+/_-]{150,}/);
  return match ? match[0] : null;
}

/** `[["er",…]]` is how the endpoint reports a rejected request even with a 200. */
export function isErrorResponse(text: string): boolean {
  try {
    const json: unknown = JSON.parse(stripXssiGuard(text));
    const first = Array.isArray(json) ? json[0] : undefined;
    return Array.isArray(first) && first[0] === 'er';
  } catch {
    return true;
  }
}

/**
 * A whole-event delete.
 *
 * The delta names the event and populates only field 20 with an empty list; the id and
 * the calendar are the change's own, so nothing else needs to be sent.
 */
export function buildDeleteChange(eventId: string, calendarId: string): unknown[] {
  const fieldBlock: unknown[] = new Array(DELETE_FIELD + 1).fill(null);
  fieldBlock[DELETE_FIELD] = [];

  const delta = [eventId, null, null, [fieldBlock], 0];
  const seq = nextSequence();
  return [seq, null, [[null, delta], calendarId], null, null, seq];
}

/**
 * An RSVP, addressed to one occurrence.
 *
 * `occurrenceId` is the `<series master>_<UTC slot>Z` the eid already carries, which is
 * what makes "this event" rather than "all events" a property of the write instead of
 * the scope dialog. The attendee block is three tuples: the attendee's row, the
 * occurrence's times as epoch milliseconds with its IANA zone, and the response.
 */
export function buildRsvpChange(
  occurrenceId: string,
  calendarId: string,
  response: number,
  startMs: number,
  endMs: number,
  timezone: string,
): unknown[] {
  const fieldBlock: unknown[] = new Array(RSVP_FIELD + 1).fill(null);
  fieldBlock[RSVP_FIELD] = [
    [0, null, '', null, 0],
    [[null, [startMs], timezone], [null, [endMs], timezone], 0],
    [response, null, '', null, 0],
  ];

  const delta = [occurrenceId, null, null, [fieldBlock], 0];
  const seq = nextSequence();
  return [seq, null, [[null, delta], calendarId], null, null, seq];
}
