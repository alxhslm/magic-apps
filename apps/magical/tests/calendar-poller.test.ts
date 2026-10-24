import { describe, it, expect, vi } from 'vitest';
import {
  CalendarPoller,
  buildEventRangeBody,
  buildSecondaryCalendarsBody,
  toEpochDay,
} from '../src/calendar-poller';
import {
  CalendarSessionExpiredError,
  CalendarDecodeError,
  CalendarNetworkError,
  CalendarRestrictedError,
} from '../src/calendar-decoder';

vi.mock('electron', () => ({
  session: { fromPartition: () => ({ fetch: async () => undefined }) },
}));

const RANGE = { start: new Date('2025-10-01T00:00:00Z'), end: new Date('2025-11-05T00:00:00Z') };

/** Wraps a payload the way the wire does, guard included. */
const wire = (payload: unknown) => `)]}'\n\n${JSON.stringify(payload)}`;

const eventTuple = (id: string, startMs: number) => {
  const t: unknown[] = new Array(85).fill(null);
  t[0] = id;
  t[5] = `Event ${id}`;
  t[35] = [startMs];
  t[36] = [startMs + 3_600_000];
  return t;
};

const rangeResponse = (calendarId: string, tuples: unknown[]) =>
  wire([['prefetcheventrangeaction.perr', 0, ['sync-token', [[calendarId, tuples]]]]]);

const secondaryResponse = (ids: string[]) =>
  wire([
    ['secondarycalendarsaction.sar', null, ['blob', ids.map((id) => [id, null, null, 2]), []]],
  ]);

const ok = (body: string) =>
  ({ ok: true, status: 200, text: async () => body }) as unknown as Response;
const status = (code: number) =>
  ({ ok: false, status: code, text: async () => '' }) as unknown as Response;

const html = (
  body: string,
  url = 'https://calendar.google.com/calendar/u/0/sync.prefetcheventrange',
) =>
  ({
    ok: true,
    status: 200,
    url,
    headers: { get: () => 'text/html; charset=UTF-8' },
    text: async () => body,
  }) as unknown as Response;

function makePoller(
  calendarIds: string[],
  handler: (url: string, init: RequestInit) => Promise<Response>,
) {
  return new CalendarPoller({
    id: 'google:acc',
    accountId: 'acc',
    partition: 'persist:magical_acc',
    calendarIds,
    fetchImpl: handler,
  });
}

describe('request building', () => {
  it('expresses the range as two scalar epoch days, not a nested pair', () => {
    const body = decodeURIComponent(buildEventRangeBody(['a@b.com'], RANGE)).replace('f.req=', '');
    const parsed = JSON.parse(body);
    expect(parsed[0][1]).toEqual([null, null, toEpochDay(RANGE.start), toEpochDay(RANGE.end)]);
  });

  it('names every calendar explicitly, since the endpoint infers none', () => {
    const body = decodeURIComponent(buildEventRangeBody(['a@b.com', 'c@d.com'], RANGE));
    const parsed = JSON.parse(body.replace('f.req=', ''));
    expect(parsed[0][0]).toEqual(['a@b.com', 'c@d.com']);
  });

  it('asks for each series occurrence schedule, which needs capability flag 6', () => {
    const body = decodeURIComponent(buildEventRangeBody(['a@b.com'], RANGE)).replace('f.req=', '');
    const flags = JSON.parse(body)[0][3];
    // Without this bit the endpoint answers with the rules and the materialised occurrences alone:
    // an occurrence Google has not placed is then absent from the agenda entirely. Measured against
    // the live endpoint, flag 6 is the difference between 0 and 46 schedules for one calendar set.
    expect(flags[6]).toBe(1);
  });

  it('builds a secondarycalendars body that needs no calendar list', () => {
    const parsed = JSON.parse(
      decodeURIComponent(buildSecondaryCalendarsBody(RANGE)).replace('f.req=', ''),
    );
    expect(parsed[0]).toBeNull();
    expect(parsed[1]).toEqual([null, null, toEpochDay(RANGE.start), toEpochDay(RANGE.end)]);
  });

  it('converts dates to epoch days', () => {
    expect(toEpochDay(new Date('1970-01-01T00:00:00Z'))).toBe(0);
    expect(toEpochDay(new Date('2025-10-13T23:30:00Z'))).toBe(20374);
  });
});

describe('CalendarPoller', () => {
  it('fetches events across the primary and secondary calendars', async () => {
    const calls: string[] = [];
    const poller = makePoller(['me@work.com'], async (url, init) => {
      calls.push(url);
      if (url.endsWith('secondarycalendars'))
        return ok(secondaryResponse(['team@group.calendar.google.com']));
      const body = decodeURIComponent(String(init.body)).replace('f.req=', '');
      expect(JSON.parse(body)[0][0]).toEqual(['me@work.com', 'team@group.calendar.google.com']);
      return ok(rangeResponse('me@work.com', [eventTuple('e1', 1789027200000)]));
    });

    const events = await poller.events(RANGE);
    expect(events.map((e) => e.id)).toEqual(['e1']);
    expect(calls.some((c) => c.endsWith('secondarycalendars'))).toBe(true);
    expect(poller.health).toBe('ok');
    expect(poller.lastSuccessfulReadAt).toBeInstanceOf(Date);
  });

  it('refuses to fetch when no calendars are known, rather than reporting no events', async () => {
    const poller = makePoller([], async () => ok(rangeResponse('other@work.com', [])));
    await expect(poller.events(RANGE)).rejects.toThrow(CalendarDecodeError);
    expect(poller.health).toBe('unreadable');
  });

  it('reports signed-out on 401 instead of an empty calendar', async () => {
    const poller = makePoller(['me@work.com'], async (url) =>
      url.endsWith('secondarycalendars') ? ok(secondaryResponse([])) : status(401),
    );
    await expect(poller.events(RANGE)).rejects.toThrow(CalendarSessionExpiredError);
    expect(poller.health).toBe('signed-out');
  });

  it('reports restricted, not signed-out, when an administrator policy refuses the endpoint', async () => {
    // A policy block cannot be repaired by signing in, so it must not draw the sign-in
    // banner; and it is not an empty day either.
    const poller = makePoller(['me@work.com'], async (url) =>
      url.endsWith('secondarycalendars') ? ok(secondaryResponse([])) : status(403),
    );
    await expect(poller.events(RANGE)).rejects.toThrow(CalendarRestrictedError);
    expect(poller.health).toBe('restricted');
  });

  it('reads an SSO redirect to the sign-in page as signed-out, not as a decode failure', async () => {
    // A tenant that sends the background request through SSO can answer 200 with the
    // sign-in page after following the redirect, where a personal account gets a 401.
    const poller = makePoller(['me@work.com'], async (url) =>
      url.endsWith('secondarycalendars')
        ? ok(secondaryResponse([]))
        : html(
            '<!doctype html><html><body><form id="gaia_loginform"><input id="identifierId" name="identifier"></form></body></html>',
            'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fcalendar.google.com',
          ),
    );
    await expect(poller.events(RANGE)).rejects.toThrow(CalendarSessionExpiredError);
    expect(poller.health).toBe('signed-out');
  });

  it('reads an HTML policy block as restricted rather than an unreadable wire format', async () => {
    const poller = makePoller(['me@work.com'], async (url) =>
      url.endsWith('secondarycalendars')
        ? ok(secondaryResponse([]))
        : html(
            '<!doctype html><html><body><h1>Access denied</h1><p>This service is blocked by your administrator.</p></body></html>',
          ),
    );
    await expect(poller.events(RANGE)).rejects.toThrow(CalendarRestrictedError);
    expect(poller.health).toBe('restricted');
  });

  it('reports offline when the request never reached Google', async () => {
    const poller = makePoller(['me@work.com'], async () => {
      throw new Error('net::ERR_INTERNET_DISCONNECTED');
    });
    await expect(poller.events(RANGE)).rejects.toThrow(CalendarNetworkError);
    expect(poller.health).toBe('offline');
  });

  it('separates a dead network from a moved wire format', async () => {
    // Google answered, so the calendar is reachable and the app is what is broken. A
    // banner telling the user to check their connection would send them after the wrong
    // problem.
    const poller = makePoller(['me@work.com'], async (url) =>
      url.endsWith('secondarycalendars') ? ok(secondaryResponse([])) : status(500),
    );
    await expect(poller.events(RANGE)).rejects.toThrow(CalendarDecodeError);
    expect(poller.health).toBe('unreadable');
  });

  it('reports offline rather than signed-out when the network drops mid-sign-in', async () => {
    // The secondary list is fetched first. A transport failure there must not fall
    // through to the degraded path, which would go on to report an unrelated failure.
    const poller = makePoller(['me@work.com'], async (url) => {
      if (url.endsWith('secondarycalendars')) throw new Error('net::ERR_NAME_NOT_RESOLVED');
      return ok(rangeResponse('me@work.com', []));
    });
    await expect(poller.events(RANGE)).rejects.toThrow(CalendarNetworkError);
    expect(poller.health).toBe('offline');
  });

  it('recovers to ok once a read succeeds after an outage', async () => {
    let online = false;
    const poller = makePoller(['me@work.com'], async (url) => {
      if (!online) throw new Error('net::ERR_INTERNET_DISCONNECTED');
      return ok(
        url.endsWith('secondarycalendars')
          ? secondaryResponse([])
          : rangeResponse('me@work.com', []),
      );
    });
    await expect(poller.events(RANGE)).rejects.toThrow(CalendarNetworkError);
    expect(poller.health).toBe('offline');

    online = true;
    await expect(poller.events(RANGE)).resolves.toEqual([]);
    expect(poller.health).toBe('ok');
  });

  it('distinguishes an empty calendar from a broken one', async () => {
    const poller = makePoller(['me@work.com'], async (url) =>
      ok(
        url.endsWith('secondarycalendars')
          ? secondaryResponse([])
          : rangeResponse('me@work.com', []),
      ),
    );
    await expect(poller.events(RANGE)).resolves.toEqual([]);
    // An empty result is a successful read; only a failure may mark the source unhealthy.
    expect(poller.health).toBe('ok');
  });

  it('still polls the primary when the secondary list is unavailable', async () => {
    const poller = makePoller(['me@work.com'], async (url) =>
      url.endsWith('secondarycalendars')
        ? status(500)
        : ok(rangeResponse('me@work.com', [eventTuple('e2', 1789027200000)])),
    );
    const events = await poller.events(RANGE);
    expect(events).toHaveLength(1);
    expect(poller.health).toBe('ok');
  });

  it('takes the calendar set it is given, and says when it changed', () => {
    const poller = makePoller(['me@work.com'], async () => ok(''));
    expect(poller.setCalendarIds(['me@work.com', 'holidays@group.calendar.google.com'])).toBe(true);
    expect(poller.setCalendarIds(['holidays@group.calendar.google.com', 'me@work.com'])).toBe(
      false,
    );
    expect(poller.getCalendarIds()).toEqual(['me@work.com', 'holidays@group.calendar.google.com']);
  });

  it('lets the set shrink, so a calendar can stop being polled', () => {
    // The union of everything ever observed is kept on the account; what reaches the
    // poller is the subset worth asking for, and that can lose a member.
    const poller = makePoller(['me@work.com', 'colleague@work.com'], async () => ok(''));
    expect(poller.setCalendarIds(['me@work.com'])).toBe(true);
    expect(poller.getCalendarIds()).toEqual(['me@work.com']);
  });

  it('re-fetches the calendar list after new calendars are observed', async () => {
    const asked: string[][] = [];
    const poller = makePoller(['me@work.com'], async (url, init) => {
      if (url.endsWith('secondarycalendars')) return ok(secondaryResponse([]));
      asked.push(JSON.parse(decodeURIComponent(String(init.body)).replace('f.req=', ''))[0][0]);
      return ok(rangeResponse('me@work.com', []));
    });

    await poller.events(RANGE);
    poller.setCalendarIds(['me@work.com', 'later@group.calendar.google.com']);
    await poller.events(RANGE);

    expect(asked[0]).toEqual(['me@work.com']);
    expect(asked[1]).toEqual(['me@work.com', 'later@group.calendar.google.com']);
  });
});
