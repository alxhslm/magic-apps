/**
 * Reading Google Calendar's displayed range.
 *
 * Calendar does not always put its date in the route: a view switch leaves the path at
 * `/r/month` or `/r/week` while the grid stays where the user was. These tests pin down
 * that the rendered `data-datekey` cells decide the range, that the route date wins when
 * it agrees with the grid, and that a day from the leading or trailing week of a month
 * does not drag the anchor into the neighbouring month.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeDateKey,
  dateKeyToISO,
  displayedMonthStart,
  visibleStartDate,
  resolveAnchorDate,
} from '../src/calendar-visible-range.js';

/** Packed the way Calendar does: `(year - 1970) << 9 | month << 5 | day`. */
function dateKey(year: number, month: number, day: number): string {
  return String(((year - 1970) << 9) | (month << 5) | day);
}

describe('decodeDateKey', () => {
  it('decodes the packed year, month and day', () => {
    expect(decodeDateKey(dateKey(2026, 11, 1))).toEqual({ year: 2026, month: 11, day: 1 });
    expect(decodeDateKey(dateKey(2026, 12, 31))).toEqual({ year: 2026, month: 12, day: 31 });
    expect(decodeDateKey(dateKey(2018, 10, 31))).toEqual({ year: 2018, month: 10, day: 31 });
  });

  it('rejects values that are not a packed date', () => {
    expect(decodeDateKey(null)).toBeNull();
    expect(decodeDateKey('')).toBeNull();
    expect(decodeDateKey('abc')).toBeNull();
    expect(decodeDateKey('-5')).toBeNull();
    // Month 13 and day 0 are not dates even though the bit fields decode.
    expect(decodeDateKey(String((56 << 9) | (13 << 5) | 1))).toBeNull();
    expect(decodeDateKey(String((56 << 9) | (1 << 5) | 0))).toBeNull();
  });

  it('formats an ISO date', () => {
    expect(dateKeyToISO(dateKey(2026, 11, 5))).toBe('2026-11-05');
  });
});

describe('displayedMonthStart', () => {
  it('picks the month with the most cells, ignoring the neighbouring weeks', () => {
    const keys = [
      // A six-week November 2026: two October days leading, one December day trailing.
      dateKey(2026, 10, 30),
      dateKey(2026, 10, 31),
      ...Array.from({ length: 30 }, (_, i) => dateKey(2026, 11, i + 1)),
      dateKey(2026, 12, 1),
    ];
    expect(displayedMonthStart(keys)).toBe('2026-11-01');
  });

  it('returns null with no dates on screen', () => {
    expect(displayedMonthStart([])).toBeNull();
    expect(displayedMonthStart(['nonsense'])).toBeNull();
  });
});

describe('visibleStartDate', () => {
  it('returns the earliest rendered day', () => {
    expect(
      visibleStartDate([dateKey(2026, 11, 3), dateKey(2026, 11, 1), dateKey(2026, 11, 2)]),
    ).toBe('2026-11-01');
  });
});

describe('resolveAnchorDate', () => {
  const novemberGrid = [
    dateKey(2026, 10, 30),
    dateKey(2026, 10, 31),
    ...Array.from({ length: 30 }, (_, i) => dateKey(2026, 11, i + 1)),
    dateKey(2026, 12, 1),
  ];

  it('follows the rendered month when the route carries no date', () => {
    expect(
      resolveAnchorDate({
        timeframe: 'month',
        routeDateStr: null,
        dateKeys: novemberGrid,
        todayISO: '2027-02-14',
      }),
    ).toBe('2026-11-01');
  });

  it('follows the rendered month when the route date is stale', () => {
    expect(
      resolveAnchorDate({
        timeframe: 'month',
        routeDateStr: '2027-02-14',
        dateKeys: novemberGrid,
        todayISO: '2027-02-14',
      }),
    ).toBe('2026-11-01');
  });

  it('keeps the selected day when the route date is in the rendered month', () => {
    expect(
      resolveAnchorDate({
        timeframe: 'month',
        routeDateStr: '2026-11-21',
        dateKeys: novemberGrid,
        todayISO: '2027-02-14',
      }),
    ).toBe('2026-11-21');
  });

  it('uses the route date for day and week views', () => {
    expect(
      resolveAnchorDate({
        timeframe: 'week',
        routeDateStr: '2026-12-07',
        dateKeys: novemberGrid,
        todayISO: '2027-02-14',
      }),
    ).toBe('2026-12-07');
  });

  it('falls back to the first rendered day, then today, when the route has none', () => {
    expect(
      resolveAnchorDate({
        timeframe: 'week',
        routeDateStr: null,
        dateKeys: [dateKey(2026, 12, 7), dateKey(2026, 12, 8)],
        todayISO: '2027-02-14',
      }),
    ).toBe('2026-12-07');

    expect(
      resolveAnchorDate({
        timeframe: 'schedule',
        routeDateStr: null,
        dateKeys: [],
        todayISO: '2027-02-14',
      }),
    ).toBe('2027-02-14');
  });
});
