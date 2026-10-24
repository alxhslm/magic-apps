import { describe, it, expect } from 'vitest';

import { allDayKey, allDayLastInstant, allDayLocalDate } from '../src/all-day.js';

/**
 * The all-day date helpers, which every all-day display site reads through.
 *
 * The wire sends an all-day entry as a bare epoch at exactly midnight UTC, so the date it
 * is on is that instant's UTC fields. These assertions hold in every zone because they read
 * those fields; the machine's zone is never the reader. The zone-sensitive end of this is
 * pinned in `calendar-allday-timezone.test.ts`.
 */
describe('the date an all-day instant is on', () => {
  it('reads the UTC date, never the machine day before it', () => {
    expect(allDayKey(new Date('2026-09-18T00:00:00.000Z'))).toBe('2026-09-18');
  });

  it('keeps a late instant on its own UTC date, so only the fields matter', () => {
    expect(allDayKey(new Date('2026-09-18T23:30:00.000Z'))).toBe('2026-09-18');
  });

  it('pads a single-digit month and day', () => {
    expect(allDayKey(new Date('2026-01-05T00:00:00.000Z'))).toBe('2026-01-05');
  });

  it('hands back a Date the machine spells as that date', () => {
    const local = allDayLocalDate(new Date('2026-09-18T00:00:00.000Z'));
    expect([local.getFullYear(), local.getMonth(), local.getDate()]).toEqual([2026, 8, 18]);
  });
});

describe('the last instant an all-day span covers', () => {
  it('steps the exclusive end back a millisecond', () => {
    const last = allDayLastInstant(
      new Date('2026-09-18T00:00:00.000Z'),
      new Date('2026-09-19T00:00:00.000Z'),
    );
    expect(last.getTime()).toBe(Date.parse('2026-09-18T23:59:59.999Z'));
  });

  it('leaves a one-day event on its own date', () => {
    const last = allDayLastInstant(
      new Date('2026-12-31T00:00:00.000Z'),
      new Date('2027-01-01T00:00:00.000Z'),
    );
    expect(allDayKey(last)).toBe('2026-12-31');
  });

  it('covers every date up to the exclusive end across the New Year boundary', () => {
    const last = allDayLastInstant(
      new Date('2026-12-30T00:00:00.000Z'),
      new Date('2027-01-02T00:00:00.000Z'),
    );
    expect(allDayKey(last)).toBe('2027-01-01');
  });
});
