import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EVENT_TYPE, type NormalizedCalendarEvent } from '../src/calendar-decoder.js';
import { collapseWorkingLocations } from '../src/working-locations.js';
import { buildWidgetCache } from '../src/widget-cache.js';
import type { SerializedTrayEvent } from '../src/menubar-manager.js';

/**
 * The all-day display round: an all-day event is a calendar date, not an instant.
 *
 * Measured against the live endpoint, an all-day entry is a bare `[epochMs]` at exactly midnight
 * UTC, on every calendar regardless of that calendar's own zone — a contact birthday, a UK bank
 * holiday and a seeded probe all arrive that way, while a timed event carries its own IANA zone
 * beside the epoch. So the date an all-day event is on is that instant's **UTC** date fields, and
 * the machine's zone must never be applied to it. A timed event is the opposite: an instant, read
 * in the Mac's zone.
 *
 * The all-day readers below apply the machine's zone to an all-day instant, so west of UTC — where
 * the UTC date and the machine's date differ for midnight UTC — an all-day event is drawn one day
 * early:
 *
 * - the invitation line (`formatInviteLine` in `notification-manager.ts`, which `formatInviteWhen`
 *   in `calendar-service.ts` delegates to) renders the all-day branch with `toLocaleDateString` and
 *   takes `sameYear` from local getters, so the toolbar dropdown and the banner say the 17th for a
 *   holiday on the 18th.
 * - `dayKey`/`startOfDay`/`daysCovered` in `widget-cache.ts` put the day's dot on the wrong cell of
 *   the mini-month grid and give a one-day holiday two days of dots.
 * - `working-locations.ts` already reads the UTC date (`toISOString().slice(0, 10)`) and is the
 *   reference the others have to match; its collapse is pinned here so a fix cannot regress it.
 *
 * The loaded-day ledger is the exception in wording only. Its coverage answers "was this range
 * fetched", so `isCoveredByLoadedDay` is judged on the event's instants, all-day and timed alike,
 * while the UTC date is only how the day is drawn. Keying coverage on the date instead drops an
 * all-day event one day past the window edge west of UTC, which the ledger block below pins.
 *
 * This file asserts the correct behaviour, so the zone it runs in decides which of these it catches:
 * an all-day date west of UTC is the machine's day before, and the exclusive end read in a zone east
 * of UTC lands on the morning after, so a one-day holiday dots two cells there. Nothing here asserts
 * a machine-local reading of an all-day instant, and the timed controls build their instants from
 * local fields, so they hold in every zone.
 */

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magical-allday-tz-'));

// `calendar-service.ts` reaches for Electron, the settings store and the helper surfaces as it
// loads. The ledger below is driven through its own fields, so none of them is exercised.
vi.mock('electron', () => ({
  app: { getPath: () => stateDir },
  powerMonitor: { on: vi.fn(), isOnBatteryPower: () => false },
  shell: { openExternal: vi.fn() },
  dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })) },
  session: {},
}));

vi.mock('../src/settings-store', () => ({
  loadSettings: () => ({
    meetingAlertsEnabled: true,
    meetingAlertLeadMinutes: 5,
    alwaysJoinInBrowser: false,
    dockBadgeMode: 'allPending',
    disabledAlertCalendarIds: [],
  }),
}));

vi.mock('../src/dock', () => ({ updateDockBadge: vi.fn() }));
vi.mock('../src/native-handlers', () => ({ hasApplicationForUrl: () => true }));
vi.mock('../src/native-toolbar', () => ({ updateNativeToolbarInvites: vi.fn() }));

const { formatInviteWhen, CalendarService } = await import('../src/calendar-service.js');

const DAY_MS = 86_400_000;

/**
 * An all-day event as the wire delivers one: a bare epoch at midnight UTC, no zone.
 *
 * `date` is the calendar date the event is on, and the end is exclusive — a one-day event ends at
 * midnight UTC on the following date.
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

/**
 * The line `formatInviteWhen` owes an all-day event.
 *
 * Written out rather than copied from the implementation: the day, the month and the weekday come
 * from the instant's UTC fields, and the year is shown only when the instant's UTC year differs
 * from the year the reader is in.
 */
function allDayInviteLine(start: Date, now: Date): string {
  const sameYear = start.getUTCFullYear() === now.getUTCFullYear();
  return start.toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

describe('the invitation line for an all-day event', () => {
  it('names the date the event is on, not the machine day before it', () => {
    const event = allDayOn('2026-09-18');
    const now = new Date('2026-09-20T12:00:00Z');

    expect(formatInviteWhen(event, now)).toBe(allDayInviteLine(event.startTime, now));
  });

  it("reads the New Year boundary on the event's own date, and takes the year from the same fields", () => {
    // Midnight UTC on 1 January is 31 December on the machine in New York, and the event's local
    // year is then 2026 while the reader is in 2027 — so the buggy branch prints a day that does
    // not exist on the calendar, in a year the invite is not in.
    const event = allDayOn('2027-01-01');
    const now = new Date('2027-01-05T12:00:00Z');

    expect(formatInviteWhen(event, now)).toBe(allDayInviteLine(event.startTime, now));
    expect(formatInviteWhen(event, now)).not.toContain('2026');
  });

  it("leaves a timed event on the machine's clock", () => {
    // A timed event is an instant, and the machine's zone is the right reader for it. Built from
    // local fields so the expectation holds wherever the suite runs.
    const event: NormalizedCalendarEvent = {
      ...allDayOn('2026-09-18'),
      isAllDay: false,
      startTime: new Date(2026, 8, 18, 14, 30),
      endTime: new Date(2026, 8, 18, 15, 0),
    };
    const now = new Date(2026, 8, 20, 12, 0);

    expect(formatInviteWhen(event, now)).toBe(
      event.startTime.toLocaleString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }),
    );
  });
});

/**
 * The loaded-day ledger, as `CalendarService` keys it: local midnight, rounded, in days.
 *
 * Mirroring `CalendarService.dayKey` here rather than reading it keeps this file black-box over the
 * ledger's own units; a day is named by the machine's calendar date for it, which is how every fetch
 * records the range it read.
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

describe('the day ledger an all-day event is judged against', () => {
  it('keeps an all-day event whose own date the ledger holds', () => {
    const event = allDayOn('2026-09-18');

    expect(surviveSweep([ledgerDayNumber(new Date(2026, 8, 18))], [event])).toEqual([event.id]);
  });

  it('keeps an all-day event whose start instant the fetched local day covered', () => {
    // Coverage answers "was this range fetched", so it is judged on the event's instants, not on the
    // UTC date the event is drawn under. West of UTC that instant's local day is the day before the
    // date — 17 September for an event on the 18th — and coverage keyed on the date instead would
    // drop an event the fetch did read.
    const event = allDayOn('2026-09-18');

    expect(surviveSweep([ledgerDayNumber(event.startTime)], [event])).toEqual([event.id]);
  });

  it('drops an all-day event no fetched day covered', () => {
    const event = allDayOn('2026-09-18');

    expect(surviveSweep([ledgerDayNumber(new Date('2026-09-10T00:00:00Z'))], [event])).toEqual([]);
  });
});

/** One all-day event as the tray payload carries it, dated by the wire's UTC midnight. */
function trayAllDay(id: string, startIso: string, endIso: string): SerializedTrayEvent {
  return {
    id,
    accountId: 'a1',
    calendarIds: ['holidays@group.v.calendar.google.com'],
    summary: 'Bank holiday',
    startTime: Date.parse(startIso),
    endTime: Date.parse(endIso),
    isAllDay: true,
    eventType: EVENT_TYPE.DEFAULT,
    colorHex: '#0b8043',
    myResponseStatus: -1,
  };
}

/** The day keys the mini-month grid dots, which is where an all-day event's day is read. */
function dottedDays(events: SerializedTrayEvent[]): string[] {
  const cache = buildWidgetCache({
    events,
    calendars: [],
    accounts: [],
    hiddenCalendars: [],
    now: Date.parse('2026-09-20T12:00:00Z'),
  });
  return Object.keys(cache.densityDots).sort();
}

describe('the widget day keys for an all-day event', () => {
  it('dots the one day a one-day all-day event is on', () => {
    // A holiday on 18 September, delivered as midnight UTC on the 18th: one cell of the grid. West
    // of UTC the whole span is read a day early, so the 17th is dotted as well; east of UTC the
    // exclusive end read in the machine's zone puts the 19th on it.
    expect(
      dottedDays([trayAllDay('holiday', '2026-09-18T00:00:00.000Z', '2026-09-19T00:00:00.000Z')]),
    ).toEqual(['2026-09-18']);
  });

  it('dots every date a multi-day all-day event covers, across the New Year boundary', () => {
    // 30 December to 1 January inclusive: the end is exclusive midnight UTC, so the last date the
    // event covers is 1 January, and neither 29 December nor 2 January is part of it.
    expect(
      dottedDays([trayAllDay('break', '2026-12-30T00:00:00.000Z', '2027-01-02T00:00:00.000Z')]),
    ).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
  });

  it("still dots a timed event on the machine's day", () => {
    // A 22:00 meeting belongs to the evening the user is having. Built from local fields, so the
    // key is the machine's date for it in every zone.
    const evening = new Date(2026, 8, 18, 22, 0, 0);
    const event: SerializedTrayEvent = {
      ...trayAllDay('standup', '2026-09-18T00:00:00.000Z', '2026-09-19T00:00:00.000Z'),
      startTime: evening.getTime(),
      endTime: evening.getTime() + 3_600_000,
      isAllDay: false,
    };

    expect(dottedDays([event])).toEqual(['2026-09-18']);
  });
});

describe('the working-location collapse across the New Year boundary', () => {
  /** A working location on `date`, as the wire states it: all-day, midnight UTC. */
  function location(
    date: string,
    over: Partial<NormalizedCalendarEvent> & { id: string },
  ): NormalizedCalendarEvent {
    return { ...allDayOn(date), summary: 'Home', eventType: EVENT_TYPE.WORKING_LOCATION, ...over };
  }

  it('collapses a series occurrence and the override set for the same all-day date', () => {
    const series = location('2027-01-01', {
      id: 'home_R20270101T000000',
      seriesId: 'home',
      recurrenceRule: 'RRULE:FREQ=WEEKLY;BYDAY=FR',
      updated: new Date('2026-06-01T09:00:00Z'),
    });
    const override = location('2027-01-01', {
      id: 'office_one_off',
      summary: 'Office',
      eventType: EVENT_TYPE.WORKING_LOCATION_ONE_OFF,
      updated: new Date('2026-12-31T09:00:00Z'),
    });

    expect(collapseWorkingLocations([series, override]).map((event) => event.id)).toEqual([
      'office_one_off',
    ]);
  });

  it('leaves the locations on the day either side of New Year alone', () => {
    const eve = location('2026-12-31', { id: 'home_R20261231T000000', seriesId: 'home' });
    const day = location('2027-01-01', {
      id: 'office_one_off',
      eventType: EVENT_TYPE.WORKING_LOCATION_ONE_OFF,
    });

    expect(
      collapseWorkingLocations([eve, day])
        .map((event) => event.id)
        .sort(),
    ).toEqual(['home_R20261231T000000', 'office_one_off']);
  });
});
