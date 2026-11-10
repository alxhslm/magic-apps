import { describe, it, expect } from 'vitest';
import {
  accountIdFromLink,
  buildEventLink,
  decodeEid,
  isAllowedCalendarNavigationUrl,
  parseEventLink,
  extractEid,
  resolveToCalendarUrl,
} from '../src/event-links';
import type { NormalizedCalendarEvent } from '../src/calendar-decoder';

const event = (overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent => ({
  id: 'evt',
  calendarIds: ['me@work.com'],
  summary: 'Standup',
  webUrl: 'https://www.google.com/calendar/event?eid=ABC123xyz',
  created: null,
  updated: null,
  startTime: new Date('2026-09-15T09:00:00Z'),
  endTime: new Date('2026-09-15T09:30:00Z'),
  isAllDay: false,
  myResponseStatus: 3,
  attendees: [],
  reminders: 'unknown',
  ...overrides,
});

describe('extractEid', () => {
  it('reads the eid Google already encoded rather than rebuilding it', () => {
    expect(extractEid(event())).toBe('ABC123xyz');
  });

  it('returns nothing for an event with no usable url', () => {
    expect(extractEid(event({ webUrl: '' }))).toBeUndefined();
    expect(extractEid(event({ webUrl: 'not a url' }))).toBeUndefined();
  });
});

describe('decodeEid', () => {
  it('splits an eid into the event and the calendar it names', () => {
    const eid = Buffer.from('abc123 me@work.com', 'utf8').toString('base64url');

    expect(decodeEid(eid)).toEqual({ eventId: 'abc123', calendarId: 'me@work.com' });
  });

  it('keeps an occurrence stamp with the event id, where the wire puts it', () => {
    const eid = Buffer.from('series_20260915 me@work.com', 'utf8').toString('base64url');

    expect(decodeEid(eid)?.eventId).toBe('series_20260915');
  });

  it('returns nothing for anything that does not decode to the two halves', () => {
    expect(decodeEid(Buffer.from('nospacehere', 'utf8').toString('base64url'))).toBeUndefined();
  });
});

describe('buildEventLink', () => {
  it('builds a precise link when an eid is available', () => {
    const target = parseEventLink(buildEventLink(event(), 'acct'));
    expect(target).toEqual({
      accountId: 'acct',
      action: 'reveal',
      eid: 'ABC123xyz',
      // Carried alongside the eid: revealing the event means routing to its day first.
      date: new Date('2026-09-15T09:00:00Z'),
    });
  });

  it('still resolves a link from before the date was carried', () => {
    expect(parseEventLink('magical://event?account=acct&eid=ABC')).toEqual({
      accountId: 'acct',
      action: 'reveal',
      eid: 'ABC',
    });
    expect(parseEventLink('magical://event?eid=ABC')).toEqual({
      action: 'reveal',
      eid: 'ABC',
    });
    expect(parseEventLink('magical://date?at=2026-11-01')).toEqual({
      action: 'reveal',
      date: new Date('2026-11-01T00:00:00.000Z'),
    });
  });

  it('falls back to a date link so a banner never carries a dead link', () => {
    const target = parseEventLink(buildEventLink(event({ webUrl: '' }), 'acct'));
    expect(target?.accountId).toBe('acct');
    expect(target?.date?.toISOString()).toBe('2026-09-15T09:00:00.000Z');
  });

  it('survives account ids needing encoding, and a base64url eid', () => {
    // Real eids are base64url: `-` and `_`, padding stripped.
    const link = buildEventLink(event({ webUrl: 'https://x/?eid=aG-lsbG8_d29y' }), 'work acct&1');
    expect(parseEventLink(link)).toEqual({
      accountId: 'work acct&1',
      action: 'reveal',
      eid: 'aG-lsbG8_d29y',
      date: new Date('2026-09-15T09:00:00Z'),
    });
  });

  it('does not turn a plus in an eid into a space', () => {
    expect(extractEid(event({ webUrl: 'https://x/?eid=a+b' }))).toBe('a+b');
  });
});

/** An eid in the shape the wire uses: base64url of `<eventId> <calendarId>`. */
const eidOf = (eventId: string, calendarId = 'me@work.com'): string =>
  Buffer.from(`${eventId} ${calendarId}`, 'utf8').toString('base64url');

/** The Google Calendar URL an event's own `webUrl` carries an eid in. */
const webUrlWith = (eid: string): string => `https://www.google.com/calendar/event?eid=${eid}`;

describe('buildEventLink for an occurrence expanded from a series', () => {
  it('names the occurrence rather than the url it inherited from the series', () => {
    // 11:30 in London on 30 October is 10:30 UTC. The series' newest materialised
    // instance is three weeks later, so the inherited url names that one.
    const expanded = event({
      id: 'series_R20261030T113000',
      instanceId: 'series_R20261030T113000',
      seriesId: 'series',
      startTime: new Date('2026-10-30T10:30:00Z'),
      endTime: new Date('2026-10-30T11:00:00Z'),
      webUrl: webUrlWith(eidOf('series_20261120T113000Z')),
    });

    const target = parseEventLink(buildEventLink(expanded, 'acct'));

    expect(decodeEid(target?.eid ?? '')).toEqual({
      eventId: 'series_20261030T103000Z',
      calendarId: 'me@work.com',
    });
  });

  it('spells an all-day occurrence as its date alone', () => {
    const expanded = event({
      id: 'holidays_R20260918',
      instanceId: 'holidays_R20260918',
      seriesId: 'holidays',
      startTime: new Date('2026-09-18T00:00:00Z'),
      endTime: new Date('2026-09-19T00:00:00Z'),
      isAllDay: true,
      webUrl: webUrlWith(eidOf('holidays_20261225')),
    });

    const target = parseEventLink(buildEventLink(expanded, 'acct'));

    expect(decodeEid(target?.eid ?? '')?.eventId).toBe('holidays_20260918');
  });

  it('leaves an occurrence the wire named itself alone', () => {
    // A materialised occurrence carries its own eid; rebuilding it would only risk
    // disagreeing with the one Google encoded.
    const materialised = event({
      id: 'series_20261120T113000Z',
      webUrl: webUrlWith(eidOf('series_20261120T113000Z')),
    });

    expect(parseEventLink(buildEventLink(materialised, 'acct'))?.eid).toBe(
      eidOf('series_20261120T113000Z'),
    );
  });

  it('leaves a task chip id as it is', () => {
    // A task's chip id is not an eid and has no calendar half to rebuild around.
    const task = event({
      id: 'series_R20261030T113000',
      instanceId: 'series_R20261030T113000',
      seriesId: 'series',
      webUrl: '',
      chipEid: 'tasks_occurrence-1',
    });

    expect(parseEventLink(buildEventLink(task, 'acct'))?.eid).toBe('tasks_occurrence-1');
  });
});

describe('parseEventLink', () => {
  it('rejects links that are not ours or are incomplete', () => {
    expect(parseEventLink('https://example.com')).toBeNull();
    expect(parseEventLink('magical://event')).toBeNull();
    expect(parseEventLink('magical://date')).toBeNull();
    expect(parseEventLink('magical://event?account=a')).toBeNull();
    expect(parseEventLink('magical://unknown?account=a')).toBeNull();
    expect(parseEventLink('magical://date?account=a&at=nonsense')).toBeNull();
    expect(parseEventLink('rubbish')).toBeNull();
  });
});

describe('resolveToCalendarUrl', () => {
  it('opens the day even when it knows the event, never the edit form', () => {
    // `/r/eventedit/<eid>` is the only URL that names an event, and it is a form. A
    // link that failed to open the event must not leave the user in an editor.
    expect(resolveToCalendarUrl({ accountId: 'a', eid: 'ABC', date: new Date(2026, 8, 15) })).toBe(
      'https://calendar.google.com/calendar/u/0/r/day/2026/9/15',
    );
  });

  it('opens the day when there is no eid', () => {
    expect(resolveToCalendarUrl({ accountId: 'a', date: new Date(2026, 8, 15) })).toBe(
      'https://calendar.google.com/calendar/u/0/r/day/2026/9/15',
    );
  });

  it('respects the account index', () => {
    expect(resolveToCalendarUrl({ accountId: 'a', date: new Date(2026, 8, 15) }, 2)).toContain(
      '/calendar/u/2/r/',
    );
  });
});

describe('link actions', () => {
  it('reads the action a link asks for', () => {
    const link = 'magical://event?account=acct&eid=ABC&at=2026-09-15T09:00:00Z&action=yes';
    expect(parseEventLink(link)?.action).toBe('yes');
  });

  it('refuses an action it does not know rather than opening the event instead', () => {
    // Doing something other than what a link asked for is worse than doing nothing.
    const link = 'magical://event?account=acct&eid=ABC&action=archive';
    expect(parseEventLink(link)).toBeNull();
  });

  it('refuses to answer or delete a link that names only a day', () => {
    expect(
      parseEventLink('magical://date?account=acct&at=2026-09-15T09:00:00Z&action=no'),
    ).toBeNull();
  });
});

describe('accountIdFromLink', () => {
  it('reads the account an event, date or search link names', () => {
    expect(accountIdFromLink('magical://event?account=work&eid=ABC&at=2026-09-15')).toBe('work');
    expect(accountIdFromLink('magical://date?account=work&at=2026-09-15')).toBe('work');
    expect(accountIdFromLink('magical://search?q=standup&account=work')).toBe('work');
    expect(
      accountIdFromLink(
        'magical://navigate?url=https%3A%2F%2Fcalendar.google.com%2Fcalendar&account=work',
      ),
    ).toBe('work');
  });

  it('leaves the choice alone for a widget link that names no account', () => {
    expect(accountIdFromLink('magical://quick-add')).toBeUndefined();
    expect(accountIdFromLink('magical://open')).toBeUndefined();
    expect(accountIdFromLink('magical://event?eid=ABC')).toBeUndefined();
  });

  it('is undefined for anything that is not a magical link', () => {
    expect(accountIdFromLink('https://calendar.google.com/?account=work')).toBeUndefined();
    expect(accountIdFromLink('not a url')).toBeUndefined();
    expect(accountIdFromLink('')).toBeUndefined();
  });
});

describe('isAllowedCalendarNavigationUrl', () => {
  it('allows Google Calendar and Tasks hosts and paths', () => {
    expect(
      isAllowedCalendarNavigationUrl('https://calendar.google.com/calendar/u/0/r/settings'),
    ).toBe(true);
    expect(
      isAllowedCalendarNavigationUrl(
        'https://calendar.google.com/calendar/u/0/r?cid=team%40group.calendar.google.com',
      ),
    ).toBe(true);
    expect(isAllowedCalendarNavigationUrl('https://tasks.google.com/embed/')).toBe(true);
    expect(
      isAllowedCalendarNavigationUrl('https://www.google.com/calendar/render?action=TEMPLATE'),
    ).toBe(true);
  });

  it('rejects external and non-calendar URLs, and plaintext http', () => {
    expect(
      isAllowedCalendarNavigationUrl('http://calendar.google.com/calendar/u/0/r/settings'),
    ).toBe(false);
    expect(isAllowedCalendarNavigationUrl('https://mail.google.com/mail/u/0/#inbox')).toBe(false);
    expect(isAllowedCalendarNavigationUrl('https://google.com/search?q=calendar')).toBe(false);
    expect(isAllowedCalendarNavigationUrl('https://evil.com/calendar.google.com')).toBe(false);
    expect(isAllowedCalendarNavigationUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedCalendarNavigationUrl('not a url')).toBe(false);
  });
});
