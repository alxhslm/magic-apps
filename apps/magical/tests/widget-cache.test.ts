import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildWidgetCache,
  dayKey,
  writeWidgetCache,
  resetWidgetCachePath,
  resetWidgetCacheContent,
  CACHE_DAYS,
} from '../src/widget-cache.js';
import type { SerializedTrayAccount, SerializedTrayEvent } from '../src/menubar-manager.js';
import type { WidgetCacheInput } from '../src/widget-cache.js';
import { parseEventLink } from '../src/event-links.js';

vi.mock('../src/swift-helper.js', () => ({
  isHelperAvailable: () => false,
  sendToHelper: vi.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;

/** Midday on a fixed date, so a test never straddles a day boundary. */
const NOW = new Date(2026, 8, 20, 12, 0, 0).getTime();

function event(overrides: Partial<SerializedTrayEvent> = {}): SerializedTrayEvent {
  return {
    id: 'e1',
    accountId: 'a1',
    calendarIds: ['work'],
    summary: 'Standup',
    startTime: NOW + 60 * 60 * 1000,
    endTime: NOW + 90 * 60 * 1000,
    isAllDay: false,
    colorHex: '#039be5',
    myResponseStatus: 0,
    ...overrides,
  };
}

function account(overrides: Partial<SerializedTrayAccount> = {}): SerializedTrayAccount {
  return {
    id: 'a1',
    name: 'Work',
    color: '#039be5',
    email: 'me@work.com',
    unreadCount: 0,
    needsAuth: false,
    ...overrides,
  };
}

/** The snapshot as the menu bar writes it, with nothing hidden unless a test says so. */
function cache(events: SerializedTrayEvent[], extra: Partial<WidgetCacheInput> = {}) {
  return buildWidgetCache({
    events,
    calendars: [],
    accounts: [],
    hiddenCalendars: [],
    now: NOW,
    ...extra,
  });
}

describe('dayKey', () => {
  it('files an event under the local day, not the UTC one', () => {
    const lateEvening = new Date(2026, 8, 20, 23, 30, 0).getTime();
    expect(dayKey(lateEvening)).toBe('2026-09-20');
  });

  it('pads single-digit months and days', () => {
    expect(dayKey(new Date(2026, 0, 5, 9, 0, 0).getTime())).toBe('2026-01-05');
  });
});

describe('buildWidgetCache', () => {
  it('carries events within the horizon and drops what is past it', () => {
    const snapshot = cache([
      event({ id: 'today' }),
      event({ id: 'far', startTime: NOW + CACHE_DAYS * DAY, endTime: NOW + CACHE_DAYS * DAY }),
    ]);

    expect(snapshot.events.map((e) => e.id)).toEqual(['today']);
  });

  it('keeps a meeting that started before now but has not finished', () => {
    const snapshot = cache([
      event({ id: 'running', startTime: NOW - 10 * 60 * 1000, endTime: NOW + 10 * 60 * 1000 }),
    ]);

    expect(snapshot.events.map((e) => e.id)).toEqual(['running']);
  });

  it('orders events by start time', () => {
    const snapshot = cache([
      event({
        id: 'later',
        startTime: NOW + 5 * 60 * 60 * 1000,
        endTime: NOW + 6 * 60 * 60 * 1000,
      }),
      event({ id: 'sooner' }),
    ]);

    expect(snapshot.events.map((e) => e.id)).toEqual(['sooner', 'later']);
  });

  it('resolves a Zoom link to the desktop client, because the intent cannot', () => {
    const snapshot = cache([event({ conferenceUrl: 'https://zoom.us/j/9876543210?pwd=abc' })]);

    expect(snapshot.events[0].joinUrl).toBe(
      'zoommtg://zoom.us/join?action=join&confno=9876543210&pwd=abc',
    );
    expect(snapshot.events[0].conferenceService).toBe('Zoom');
  });

  it('leaves a Meet link alone and still names the service', () => {
    const snapshot = cache([event({ conferenceUrl: 'https://meet.google.com/abc-defg-hij' })]);

    expect(snapshot.events[0].joinUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(snapshot.events[0].conferenceService).toBe('Google Meet');
  });

  it('omits the join fields for an event with no conference link', () => {
    const snapshot = cache([event()]);

    expect(snapshot.events[0].joinUrl).toBeUndefined();
    expect(snapshot.events[0].conferenceService).toBeUndefined();
  });

  it('reveals the event itself when the tray payload names one', () => {
    const snapshot = cache([
      event({ deepLink: 'magical://event?account=work-account&eid=abc123' }),
    ]);

    const target = parseEventLink(snapshot.events[0].openUrl!);
    expect(target?.eid).toBe('abc123');
    expect(target?.accountId).toBe('work-account');
  });

  it('falls back to the day when the event has no link of its own', () => {
    const snapshot = cache([event({ accountId: 'work-account' })]);

    const target = parseEventLink(snapshot.events[0].openUrl!);
    expect(target?.eid).toBeUndefined();
    expect(target?.accountId).toBe('work-account');
    expect(target?.date?.getTime()).toBe(event().startTime);
  });

  it('carries the account a day cell in the grid opens', () => {
    expect(cache([event()], { activeAccountId: 'account_personal' }).activeAccountId).toBe(
      'account_personal',
    );
    expect(cache([event()]).activeAccountId).toBeUndefined();
  });

  it('carries every event, because each widget filters for itself', () => {
    // The choice of calendars lives in a widget's own configuration, which only the
    // extension can read; filtering here would decide for it.
    const snapshot = cache([event({ accountId: 'a1', calendarIds: ['recruiting'] })], {
      hiddenCalendars: [{ accountId: 'a1', calendarId: 'recruiting' }],
    });

    expect(snapshot.events.map((e) => e.id)).toEqual(['e1']);
    expect(snapshot.events[0].calendarIds).toEqual(['recruiting']);
    expect(snapshot.hiddenCalendars).toEqual([{ accountId: 'a1', calendarId: 'recruiting' }]);
  });

  it('offers each calendar to the picker under the account holding it', () => {
    const snapshot = cache([event()], {
      calendars: [
        { id: 'work', accountId: 'a1', name: 'Alex', colorHex: '#039be5' },
        { id: 'birthdays', accountId: 'a2', name: 'Birthdays', colorHex: '#0b8043' },
      ],
      accounts: [
        account({ id: 'a1', name: 'Work', email: 'me@work.com' }),
        account({ id: 'a2', name: 'Home', email: '' }),
      ],
    });

    expect(snapshot.calendars).toEqual([
      {
        accountId: 'a1',
        calendarId: 'work',
        accountName: 'me@work.com',
        name: 'Alex',
        colorHex: '#039be5',
      },
      {
        accountId: 'a2',
        calendarId: 'birthdays',
        accountName: 'Home',
        name: 'Birthdays',
        colorHex: '#0b8043',
      },
    ]);
  });

  it('gives a day one dot per calendar with something on it', () => {
    const dots = cache([
      event({ id: '1', calendarIds: ['work'], colorHex: '#039be5' }),
      event({ id: '2', calendarIds: ['work'], colorHex: '#039be5' }),
      event({ id: '3', calendarIds: ['family'], colorHex: '#0b8043' }),
    ]).densityDots['2026-09-20'];

    expect(dots).toEqual([
      { accountId: 'a1', calendarId: 'work', colorHex: '#039be5' },
      { accountId: 'a1', calendarId: 'family', colorHex: '#0b8043' },
    ]);
  });

  it('dots a day once for each calendar an event is on', () => {
    const dots = cache([event({ calendarIds: ['work', 'recruiting'] })]).densityDots['2026-09-20'];

    expect(dots.map((dot) => dot.calendarId)).toEqual(['work', 'recruiting']);
  });

  it('dots every day a multi-day event covers, not just the day it starts', () => {
    // An all-day entry reaches the app as a bare epoch at midnight UTC, so it is built that
    // way here rather than from local fields: a date, not the machine's instant for it.
    const snapshot = cache([
      event({
        isAllDay: true,
        startTime: Date.parse('2026-09-17T00:00:00Z'),
        endTime: Date.parse('2026-09-22T00:00:00Z'),
      }),
    ]);

    expect(Object.keys(snapshot.densityDots).sort()).toEqual([
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
    ]);
  });

  it('does not dot the morning after a one-day all-day event', () => {
    // Midnight UTC on the 20th and the 21st, the shape the wire sends an all-day day in: the
    // dot belongs on the 20th in every zone, not on the 19th west of UTC nor the 21st east of it.
    const snapshot = cache([
      event({
        isAllDay: true,
        startTime: Date.parse('2026-09-20T00:00:00Z'),
        endTime: Date.parse('2026-09-21T00:00:00Z'),
      }),
    ]);

    expect(Object.keys(snapshot.densityDots)).toEqual(['2026-09-20']);
  });

  it('caps a day well above the four dots the grid draws, because a widget filters after this', () => {
    const calendars = Array.from({ length: 20 }, (_, i) => `cal_${i}`);
    const dots = cache(
      calendars.map((calendarId, i) => event({ id: `e${i}`, calendarIds: [calendarId] })),
    ).densityDots['2026-09-20'];

    expect(dots).toHaveLength(12);
  });

  it('counts dots beyond the horizon, because the grid spans the month', () => {
    const snapshot = cache([
      event({ id: 'far', startTime: NOW + 10 * DAY, endTime: NOW + 10 * DAY }),
    ]);

    expect(snapshot.events).toHaveLength(0);
    expect(Object.keys(snapshot.densityDots)).toHaveLength(1);
  });

  it('preserves isCompleted on task events', () => {
    const snapshot = cache([
      event({ id: 'task1', eventType: 7, isCompleted: true }),
      event({ id: 'task2', eventType: 7, isCompleted: false }),
    ]);

    expect(snapshot.events[0].isCompleted).toBe(true);
    expect(snapshot.events[1].isCompleted).toBe(false);
  });
});

describe('writeWidgetCache', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magical-widget-'));
    resetWidgetCachePath();
    resetWidgetCacheContent();
  });

  it('writes nothing when there is no App Group container', () => {
    expect(writeWidgetCache(cache([event()]), () => null)).toBe(false);
  });

  it('writes the snapshot into the container', () => {
    const wrote = writeWidgetCache(cache([event()]), () => dir);

    expect(wrote).toBe(true);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'widget-cache.json'), 'utf8'));
    expect(written.events[0].title).toBe('Standup');
  });

  it('leaves no temporary file behind, so the extension never sees half a document', () => {
    writeWidgetCache(cache([event()]), () => dir);

    expect(fs.readdirSync(dir)).toEqual(['widget-cache.json']);
  });

  it('does not rewrite when only the poll time moved', () => {
    const resolve = () => dir;
    expect(writeWidgetCache(cache([event()]), resolve)).toBe(true);
    expect(writeWidgetCache(cache([event()], { now: NOW + 5 * 60 * 1000 }), resolve)).toBe(false);
  });

  it('rewrites when an event changed', () => {
    const resolve = () => dir;
    writeWidgetCache(cache([event()]), resolve);

    expect(writeWidgetCache(cache([event({ summary: 'Standup (moved)' })]), resolve)).toBe(true);
  });

  it('rewrites when Focus becomes active', () => {
    const resolve = () => dir;
    writeWidgetCache(cache([event()]), resolve);

    expect(
      writeWidgetCache(
        cache([event()], {
          isFocusActive: true,
          silencedCalendars: [{ accountId: 'a1', calendarId: 'work' }],
        }),
        resolve,
      ),
    ).toBe(true);
  });

  it('rewrites when the silenced calendar list changes under an active filter', () => {
    const resolve = () => dir;
    writeWidgetCache(
      cache([event()], {
        isFocusActive: true,
        silencedCalendars: [{ accountId: 'a1', calendarId: 'work' }],
      }),
      resolve,
    );

    expect(
      writeWidgetCache(
        cache([event()], {
          isFocusActive: true,
          silencedCalendars: [{ accountId: 'a1', calendarId: 'recruiting' }],
        }),
        resolve,
      ),
    ).toBe(true);
  });
});

describe('buildWidgetCache — Focus fields', () => {
  it('carries isFocusActive and silencedCalendars into the snapshot', () => {
    const snapshot = cache([event()], {
      isFocusActive: true,
      silencedCalendars: [{ accountId: 'a1', calendarId: 'work' }],
    });

    expect(snapshot.isFocusActive).toBe(true);
    expect(snapshot.silencedCalendars).toEqual([{ accountId: 'a1', calendarId: 'work' }]);
  });

  it('omits both fields when Focus is not active', () => {
    const snapshot = cache([event()]);

    expect(snapshot.isFocusActive).toBeUndefined();
    expect(snapshot.silencedCalendars).toBeUndefined();
  });
});
