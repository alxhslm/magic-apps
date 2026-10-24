import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EVENT_TYPE, type NormalizedCalendarEvent } from '../src/calendar-decoder.js';
import { buildEventLink, parseEventLink, resolveToCalendarUrl } from '../src/event-links.js';

/**
 * The all-day display round's blocked surfaces, west of UTC.
 *
 * An all-day entry arrives as a bare epoch at exactly midnight UTC and is a calendar date;
 * a timed entry is an instant and is read on the machine's clock. Everything here is written
 * for the four readers that still apply the machine's zone to the date, so the zone the suite
 * runs in decides which of them it catches: under `TZ=America/New_York` — where midnight UTC
 * is the evening before on the machine — each of these fails against the current source;
 * `TZ=Pacific/Auckland` is the control, where the machine's date for a midnight-UTC instant
 * already is the UTC date and the same assertions pass.
 *
 * The four:
 *
 * - the day link a banner carries: `buildEventLink` stores `at=startTime.toISOString()` and
 *   `resolveToCalendarUrl`/`AccountsManager.pathForDate` read it back with local getters, so an
 *   all-day event opens the day before west of UTC;
 * - the invitation banner: `dispatchInvite` takes a `startTime` and no `isAllDay`, so an
 *   all-day invitation prints a clock time it does not have;
 * - the loaded-day ledger's coverage: it answers "was this range fetched", so it is judged on
 *   the event's instants, while the UTC date is only how a day is drawn;
 * - Swift's `TrayModel.dateKey`/`groupedScheduleDays`/`densityDotsByDay` and `WidgetCache.byDay`,
 *   pinned in `swift/Tests/MagicalHelperLibTests/AllDayDisplayTests.swift`.
 */

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magical-allday-surfaces-'));

// `calendar-service.ts` reaches for Electron, the settings store and the helper surfaces as it
// loads, and `accounts-manager.ts` for a window and a session. The ledger and the reveal below
// are driven through their own fields, so none of the rest is exercised.
vi.mock('electron', () => ({
  app: { getPath: () => stateDir },
  powerMonitor: { on: vi.fn(), isOnBatteryPower: () => false },
  shell: { openExternal: vi.fn() },
  dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })) },
  ipcMain: { on: vi.fn() },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
  session: {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onBeforeRequest: vi.fn() },
      setUserAgent: vi.fn(),
    })),
  },
  WebContentsView: vi.fn().mockImplementation(function () {
    return {
      webContents: {
        loadURL: vi.fn(),
        getURL: vi.fn(() => 'https://calendar.google.com/calendar/u/0/r/week/2026/9/14'),
        getTitle: vi.fn(() => 'Calendar'),
        executeJavaScript: vi.fn().mockResolvedValue(true),
        sendInputEvent: vi.fn(),
        focus: vi.fn(),
        isDestroyed: vi.fn(() => false),
        isLoading: vi.fn(() => false),
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        setBackgroundThrottling: vi.fn(),
      },
      setBackgroundColor: vi.fn(),
      setBounds: vi.fn(),
    };
  }),
}));

vi.mock('../src/settings-store.js', () => ({
  SUSPEND_NEVER: 0,
  loadSettings: () => ({
    meetingAlertsEnabled: true,
    meetingAlertLeadMinutes: 5,
    alwaysJoinInBrowser: false,
    dockBadgeMode: 'allPending',
    disabledAlertCalendarIds: [],
    theme: 'system',
    transparentBackground: true,
    hideSidebar: false,
    addEventAccountPicker: 'active',
    inactiveAccountSuspendMinutes: 5,
  }),
}));

vi.mock('../src/dock.js', () => ({ updateDockBadge: vi.fn() }));
vi.mock('../src/native-handlers.js', () => ({ hasApplicationForUrl: () => true }));
vi.mock('../src/native-toolbar.js', () => ({ updateNativeToolbarInvites: vi.fn() }));

// The helper is stubbed out, and reports itself absent until the banner test asks it not to:
// a dispatch that goes nowhere is the only way to read what a banner would say.
vi.mock('../src/swift-helper.js', () => ({
  sendToHelper: vi.fn(),
  isHelperAvailable: vi.fn(() => false),
}));

const { isHelperAvailable, sendToHelper } = await import('../src/swift-helper.js');
const { dispatchInvite } = await import('../src/notification-manager.js');
const { CalendarService } = await import('../src/calendar-service.js');
const { AccountsManager } = await import('../src/accounts-manager.js');

const DAY_MS = 86_400_000;

/**
 * An all-day event as the wire delivers one: a bare epoch at midnight UTC, no zone.
 *
 * `date` is the calendar date the event is on, and the end is exclusive — a one-day event ends
 * at midnight UTC on the following date.
 */
function allDayOn(date: string, spanDays = 1): NormalizedCalendarEvent {
  const startTime = new Date(`${date}T00:00:00.000Z`);
  return {
    id: `allday_${date}`,
    calendarIds: ['holidays@group.v.calendar.google.com'],
    summary: 'Bank holiday',
    webUrl: '',
    created: null,
    updated: null,
    startTime,
    endTime: new Date(startTime.getTime() + spanDays * DAY_MS),
    isAllDay: true,
    eventType: EVENT_TYPE.DEFAULT,
    attendees: [],
    myResponseStatus: 'notInvited',
    reminders: { overrides: [], useDefault: true },
  };
}

/** The same event as Google serves it, so the link carries an `eid` rather than a bare date. */
function allDayWithEid(date: string): NormalizedCalendarEvent {
  return {
    ...allDayOn(date),
    webUrl: `https://www.google.com/calendar/event?eid=${Buffer.from(`allday_${date} holidays@group.v.calendar.google.com`, 'utf8').toString('base64url')}`,
  };
}

/** A timed event built from local fields, so its day is the reader's in every zone. */
function timedOn(year: number, month: number, day: number, hour: number): NormalizedCalendarEvent {
  return {
    ...allDayOn(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`),
    isAllDay: false,
    startTime: new Date(year, month - 1, day, hour, 0, 0),
    endTime: new Date(year, month - 1, day, hour + 1, 0, 0),
  };
}

describe('the day link an all-day event carries', () => {
  it('resolves to the date the event is on, not the machine day before it', () => {
    const event = allDayWithEid('2026-09-18');
    const target = parseEventLink(buildEventLink(event, 'acc_1'));

    expect(target).not.toBeNull();
    expect(resolveToCalendarUrl(target!)).toBe(
      'https://calendar.google.com/calendar/u/0/r/day/2026/9/18',
    );
  });

  it('carries the New Year boundary as 1 January rather than 31 December', () => {
    const event = allDayWithEid('2027-01-01');
    const target = parseEventLink(buildEventLink(event, 'acc_1'));

    expect(target).not.toBeNull();
    expect(resolveToCalendarUrl(target!)).toBe(
      'https://calendar.google.com/calendar/u/0/r/day/2027/1/1',
    );
  });

  it('resolves a date-only link, the form a banner falls back to', () => {
    const target = parseEventLink(buildEventLink(allDayOn('2026-09-18'), 'acc_1'));

    expect(target).not.toBeNull();
    expect(resolveToCalendarUrl(target!)).toBe(
      'https://calendar.google.com/calendar/u/0/r/day/2026/9/18',
    );
  });

  it("leaves a timed event on the machine's day", () => {
    const target = parseEventLink(buildEventLink(timedOn(2026, 9, 18, 14), 'acc_1'));

    expect(target).not.toBeNull();
    expect(resolveToCalendarUrl(target!)).toBe(
      'https://calendar.google.com/calendar/u/0/r/day/2026/9/18',
    );
  });
});

/** The invitation a banner posts for one event, read back as the helper would receive it. */
const INVITE = {
  key: 'invite_1',
  accountId: 'acc_1',
  calendarIds: ['holidays@group.v.calendar.google.com'],
  eventId: 'allday_2026-09-18',
  summary: 'Bank holiday',
  organizerEmail: 'organiser@example.com',
  deepLink: 'magical://date?account=acc_1&at=2026-09-18',
};

/** The body line `dispatchInvite` posts for an event. */
function inviteBody(startTime: Date, isAllDay: boolean): string {
  vi.mocked(isHelperAvailable).mockReturnValue(true);
  vi.mocked(sendToHelper).mockClear();

  // Built as its own value rather than as a literal: `isAllDay` is the field the banner needs
  // and does not yet take, and a literal would be refused for a property the caller is right
  // to send.
  const invite = { ...INVITE, startTime, isAllDay };
  dispatchInvite(invite);

  const dispatch = vi.mocked(sendToHelper).mock.calls.at(-1);
  expect(dispatch?.[0]).toBe('alert.dispatch');
  return String((dispatch?.[1] as Record<string, unknown> | undefined)?.body ?? '');
}

describe('the invitation banner for an all-day event', () => {
  it('names the date and shows no clock time', () => {
    // A bank holiday is a date. A banner that says `Thu, Sep 17, 08:00 PM` names a day the
    // event is not on and an hour it does not have.
    const body = inviteBody(allDayOn('2026-09-18').startTime, true);

    expect(body).toContain('18');
    expect(body).not.toContain('17');
    expect(body).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('carries the New Year boundary as 1 January', () => {
    const body = inviteBody(allDayOn('2027-01-01').startTime, true);

    expect(body).toContain('1');
    expect(body).not.toContain('2026');
    expect(body).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("leaves a timed invitation on the machine's clock", () => {
    const body = inviteBody(timedOn(2026, 9, 18, 14).startTime, false);

    expect(body).toContain('18');
    expect(body).toMatch(/\d{1,2}:\d{2}/);
  });
});

/**
 * The ledger day a moment is filed under: local midnight, rounded, in days.
 *
 * Mirroring `CalendarService.dayKey` here rather than reading it keeps this file black-box over
 * the ledger's own units, which are the machine's calendar days because that is what a fetch
 * records.
 */
function ledgerDayNumber(at: Date): number {
  const local = new Date(at.getTime());
  local.setHours(0, 0, 0, 0);
  return Math.round(local.getTime() / DAY_MS);
}

/** What survives the cache sweep for one account, given the days the ledger holds. */
function surviveSweep(loadedDays: number[], events: NormalizedCalendarEvent[]): string[] {
  const service = new CalendarService(
    () => [],
    () => {},
    async () => 'ok' as const,
  );
  (service as any).loadedDays.set(
    'a',
    new Map(loadedDays.map((day) => [day, { at: Date.now(), from: 0, to: 0 }])),
  );
  (service as any).cachedEvents.set('a', events);
  (service as any).pruneEventCache();
  return (service.getCachedEvents().get('a') ?? []).map((event) => event.id);
}

describe('the ledger coverage an all-day event is judged against', () => {
  it('keeps an all-day event whose instant the fetched range covered', () => {
    // The ledger read the local day the event's instant falls in. West of UTC that day is the
    // one before the event's UTC date — 18 September for an event on the 19th — and a coverage
    // keyed on the date rather than the instant finds nothing loaded and drops an event the
    // fetch did read.
    const event = allDayOn('2026-09-19');

    expect(surviveSweep([ledgerDayNumber(event.startTime)], [event])).toEqual([event.id]);
  });

  it('keeps an all-day event on the window edge whose UTC date is the next local day', () => {
    // The trailing edge of the retention window: the ledger holds the day the event starts in
    // and nothing after it. Its UTC date is one day past that edge, which is a fact about how
    // the day is drawn and not about what was fetched.
    const event = allDayOn('2026-09-18');

    expect(surviveSweep([ledgerDayNumber(event.startTime)], [event])).toEqual([event.id]);
  });

  it('drops an all-day event no loaded day covers', () => {
    const event = allDayOn('2026-09-18');

    expect(surviveSweep([ledgerDayNumber(new Date('2026-09-10T00:00:00Z'))], [event])).toEqual([]);
  });

  it('keeps a timed event whose instant the fetched range covered', () => {
    const event = timedOn(2026, 9, 18, 14);

    expect(surviveSweep([ledgerDayNumber(event.startTime)], [event])).toEqual([event.id]);
  });
});

/**
 * The reveal path, which is the other reader of the date a link carries.
 *
 * `AccountsManager.pathForDate` names the route day with local getters, so an all-day link whose
 * `at` is the UTC midnight instant sends the user to the day before west of UTC. This drives the
 * reveal with exactly the date the link carries, which is what `CalendarService.openDeepLink`
 * hands it.
 */
const mockWindow = {
  getContentSize: () => [1000, 800],
  on: vi.fn(),
  contentView: { children: [] as unknown[], addChildView: vi.fn(), removeChildView: vi.fn() },
} as never;

function revealHarness(currentPath = '/calendar/u/0/r/week/2026/9/14') {
  const manager = new AccountsManager(mockWindow, '/fake/preload.js');
  const view = manager.getActiveView();
  const scripts: string[] = [];
  let livePath = currentPath;

  vi.mocked(view!.webContents.getURL).mockImplementation(
    () => `https://calendar.google.com${livePath}`,
  );
  vi.mocked(view!.webContents.executeJavaScript).mockImplementation((script: string) => {
    scripts.push(script);
    if (script.includes('location.pathname + location.search')) return Promise.resolve(currentPath);
    if (script.includes('data-viewkey')) return Promise.resolve(null);
    if (script.includes('eventedit')) return Promise.resolve(false);
    if (script.includes('elementFromPoint')) return Promise.resolve({ x: 120, y: 80 });
    if (script.includes('getBoundingClientRect')) {
      return Promise.resolve({ x: 100, y: 100, width: 50, height: 30 });
    }
    if (script.includes('Boolean(document.querySelector') && script.includes('data-eventid')) {
      return Promise.resolve(true);
    }
    if (script.includes('pushState')) {
      const pushed = /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(script)?.[1];
      if (pushed) livePath = pushed;
      return Promise.resolve(true);
    }
    return Promise.resolve(true);
  });

  return { manager, accountId: manager.getAccounts()[0].id, scripts };
}

const pushedPath = (scripts: string[]): string | undefined =>
  /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(
    scripts.find((s) => s.includes('pushState')) ?? '',
  )?.[1];

describe('the reveal an all-day day link routes', () => {
  it("opens the event's own date rather than the machine day before it", async () => {
    const { manager, accountId, scripts } = revealHarness();
    const target = parseEventLink(buildEventLink(allDayWithEid('2026-09-18'), accountId));

    expect(target?.eid).toBeDefined();
    await manager.revealEvent(accountId, target!.eid!, target!.date!);

    expect(pushedPath(scripts)).toBe('/calendar/u/0/r/week/2026/9/18');
  });

  it("leaves a timed event on the machine's day", async () => {
    const { manager, accountId, scripts } = revealHarness();
    const target = parseEventLink(buildEventLink(timedOn(2026, 9, 18, 14), accountId));

    await manager.revealEvent(accountId, target!.eid ?? 'EID', target!.date!);

    expect(pushedPath(scripts)).toBe('/calendar/u/0/r/week/2026/9/18');
  });
});
