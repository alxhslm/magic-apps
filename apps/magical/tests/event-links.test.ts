import { describe, it, expect } from 'vitest';
import {
  accountIdFromLink,
  buildEventLink,
  decodeEid,
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

describe('parseEventLink', () => {
  it('rejects links that are not ours or are incomplete', () => {
    expect(parseEventLink('https://example.com')).toBeNull();
    expect(parseEventLink('magical://event?eid=abc')).toBeNull();
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
