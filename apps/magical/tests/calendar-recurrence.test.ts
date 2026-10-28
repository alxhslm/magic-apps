import { describe, it, expect } from 'vitest';
import { expandRecurringEvents, type DateRange } from '../src/calendar-recurrence.js';
import {
  parsePrefetchEventRangeResponse,
  IDX,
  type NormalizedCalendarEvent,
} from '../src/calendar-decoder.js';

interface Spec {
  id: string;
  start: string;
  end: string;
  seriesId?: string;
  uid?: string;
  summary?: string;
  status?: number;
  /** The wire's short tombstone: no times at all. */
  noTimes?: boolean;
  /** The series' occurrence schedule, as the wire lists it at `IDX.occurrenceList` slot 11. */
  starts?: string[];
  /** An `RRULE`, to prove the schedule wins over it. */
  recurrence?: string[];
  /** The all-day spelling of the same list: `[YYYYMMDD, [epoch]]` per occurrence. */
  allDayStarts?: string[];
}

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function tuple(spec: Spec): unknown[] {
  const t: unknown[] = new Array(92).fill(null);
  t[IDX.id] = spec.id;
  t[IDX.status] = spec.status ?? 0;
  t[IDX.summary] = spec.summary ?? 'Example series';
  if (spec.seriesId) t[IDX.seriesId] = spec.seriesId;
  if (spec.recurrence) t[IDX.recurrence] = spec.recurrence;
  if (spec.uid) t[IDX.uid] = spec.uid;
  if (!spec.noTimes) {
    t[IDX.start] = [null, [new Date(spec.start).getTime()], 'Europe/London'];
    t[IDX.end] = [null, [new Date(spec.end).getTime()], 'Europe/London'];
  }
  if (spec.starts || spec.allDayStarts) {
    const field: unknown[] = new Array(12).fill(null);
    field[11] = (spec.starts ?? []).map((iso) => [stamp(iso), [null, [new Date(iso).getTime()]]]);
    for (const day of spec.allDayStarts ?? []) {
      field[11] = field[11] as unknown[];
      (field[11] as unknown[]).push([day.replace(/-/g, ''), [Date.parse(`${day}T00:00:00.000Z`)]]);
    }
    t[IDX.occurrenceList] = field;
  }
  return t;
}

function decode(events: unknown[][]): NormalizedCalendarEvent[] {
  const calendars = [['primary@example.com', events, [null, null, 0, 0], 3]];
  const body = `)]}'\n\n${JSON.stringify([['prefetcheventrangeaction.perr', 0, ['syncToken', calendars]]])}`;
  return parsePrefetchEventRangeResponse(body, 'primary@example.com').events;
}

const range: DateRange = {
  start: new Date('2026-10-02T00:00:00.000Z'),
  end: new Date('2026-12-12T23:59:59.000Z'),
};

/**
 * A recurring series ships its own schedule, and its master record can be gone.
 *
 * Field 63 slot 11 holds one `[stamp, [null, [epoch]]]` per occurrence. A "this and following"
 * split removes the master tuple — leaving no rule to expand — while the `_R` anchor keeps the
 * schedule, and the materialised copy of the anchor's own occurrence wins the fold against it. So
 * the schedule has to survive the fold and be usable on its own, or the moved-out half of the
 * series has neither a rule nor a schedule and loses every future occurrence.
 */
describe('a series whose occurrence schedule is its only source', () => {
  it('keeps the schedule when the materialised copy wins the fold', () => {
    const events = decode([
      tuple({
        id: 'series_a_20261002T130000Z',
        seriesId: 'series_a',
        uid: 'series_a@example.com',
        start: '2026-10-02T13:00:00.000Z',
        end: '2026-10-02T14:00:00.000Z',
      }),
      tuple({
        id: 'series_a_R20261002T130000',
        seriesId: 'series_a',
        uid: 'series_a@example.com',
        start: '2026-10-02T13:00:00.000Z',
        end: '2026-10-02T14:00:00.000Z',
        starts: ['2026-10-16T13:00:00.000Z', '2026-10-23T13:00:00.000Z'],
      }),
    ]);

    const merged = events.filter((e) => e.seriesId === 'series_a');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.occurrenceStarts?.map((d) => d.toISOString())).toEqual([
      '2026-10-16T13:00:00.000Z',
      '2026-10-23T13:00:00.000Z',
    ]);
  });

  it('emits the listed occurrences when no master rule survives', () => {
    const events = decode([
      tuple({
        id: 'series_b_R20261002T130000',
        seriesId: 'series_b',
        start: '2026-10-02T13:00:00.000Z',
        end: '2026-10-02T14:00:00.000Z',
        starts: ['2026-10-16T13:00:00.000Z', '2026-10-23T13:00:00.000Z'],
      }),
    ]);

    const out = expandRecurringEvents(events, range);
    const days = out.map((e) => e.startTime.toISOString());
    expect(days).toContain('2026-10-16T13:00:00.000Z');
    expect(days).toContain('2026-10-23T13:00:00.000Z');
    expect(out.every((e) => e.summary === 'Example series')).toBe(true);
  });

  it("takes an emitted occurrence from the series' latest instance, not the anchor's frozen copy", () => {
    const events = decode([
      tuple({
        id: 'series_c_R20261002T130000',
        seriesId: 'series_c',
        summary: 'Stale title',
        start: '2026-10-02T13:00:00.000Z',
        end: '2026-10-02T14:00:00.000Z',
        starts: ['2026-11-20T14:00:00.000Z'],
      }),
      tuple({
        id: 'series_c_20261106T140000Z',
        seriesId: 'series_c',
        summary: 'Current title',
        start: '2026-11-06T14:00:00.000Z',
        end: '2026-11-06T15:00:00.000Z',
      }),
    ]);

    const out = expandRecurringEvents(events, range);
    const generated = out.find((e) => e.startTime.toISOString() === '2026-11-20T14:00:00.000Z');
    expect(generated).toBeDefined();
    expect(generated!.summary).toBe('Current title');
    expect(generated!.endTime.toISOString()).toBe('2026-11-20T15:00:00.000Z');
  });

  it('keeps two occurrences that share an event id, which the feed reuses', () => {
    const events = decode([
      tuple({
        id: 'reused_id',
        start: '2026-10-05T13:00:00.000Z',
        end: '2026-10-05T14:00:00.000Z',
      }),
      tuple({
        id: 'reused_id',
        start: '2026-10-19T13:00:00.000Z',
        end: '2026-10-19T14:00:00.000Z',
      }),
    ]);

    const out = expandRecurringEvents(events, range);
    expect(out.map((e) => e.startTime.toISOString())).toEqual([
      '2026-10-05T13:00:00.000Z',
      '2026-10-19T13:00:00.000Z',
    ]);
  });

  it('reads the all-day spelling of the schedule, as a working-location series uses', () => {
    const events = decode([
      tuple({
        id: 'office_series',
        seriesId: 'office_series',
        summary: 'Office',
        start: '2026-10-01T00:00:00.000Z',
        end: '2026-10-02T00:00:00.000Z',
        allDayStarts: ['2026-10-06', '2026-10-13'],
      }),
    ]);

    const merged = events.filter((e) => e.seriesId === 'office_series');
    expect(merged).toHaveLength(1);
    expect(merged[0]!.occurrenceStarts?.map((d) => d.toISOString().slice(0, 10))).toEqual([
      '2026-10-06',
      '2026-10-13',
    ]);
  });

  it('keeps a materialised instance and drops one outside the range', () => {
    const events = decode([
      tuple({ id: 'solo_a', start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T14:00:00.000Z' }),
      tuple({ id: 'solo_b', start: '2027-01-05T13:00:00.000Z', end: '2027-01-05T14:00:00.000Z' }),
    ]);

    expect(expandRecurringEvents(events, range).map((e) => e.id)).toEqual(['solo_a']);
  });

  it('drops a series whose master is cancelled at a slot', () => {
    const events = decode([
      tuple({
        id: 'series_d_20261005T130000Z',
        seriesId: 'series_d',
        start: '2026-10-05T13:00:00.000Z',
        end: '2026-10-05T14:00:00.000Z',
      }),
      tuple({
        id: 'series_d',
        status: 2,
        start: '2026-10-05T13:00:00.000Z',
        end: '2026-10-05T14:00:00.000Z',
      }),
    ]);

    expect(expandRecurringEvents(events, range)).toHaveLength(0);
  });

  it('keeps the occurrences of a series whose master record was removed', () => {
    const events = decode([
      tuple({
        id: 'series_e_20261005T130000Z',
        seriesId: 'series_e',
        start: '2026-10-05T13:00:00.000Z',
        end: '2026-10-05T14:00:00.000Z',
      }),
      tuple({ id: 'series_e', status: 2, noTimes: true }),
    ]);

    expect(expandRecurringEvents(events, range).map((e) => e.id)).toEqual([
      'series_e_20261005T130000Z',
    ]);
  });

  it('still emits the schedule of a series whose master record was removed', () => {
    const events = decode([
      tuple({
        id: 'series_f_R20261002T130000',
        seriesId: 'series_f',
        start: '2026-10-02T13:00:00.000Z',
        end: '2026-10-02T14:00:00.000Z',
        starts: ['2026-11-20T14:00:00.000Z'],
      }),
      tuple({ id: 'series_f', status: 2, noTimes: true }),
    ]);

    const out = expandRecurringEvents(events, range);
    expect(out.some((e) => e.startTime.toISOString() === '2026-11-20T14:00:00.000Z')).toBe(true);
  });

  it('drops a deleted _R anchor but keeps the schedule it carries', () => {
    const events = decode([
      tuple({
        id: 'series_j',
        seriesId: 'series_j',
        summary: 'Old title',
        start: '2026-04-21T10:00:00.000Z',
        end: '2026-04-21T10:30:00.000Z',
        recurrence: ['RRULE:FREQ=WEEKLY'],
        starts: ['2026-04-21T10:00:00.000Z', '2026-04-28T10:00:00.000Z'],
      }),
      // The anchor for a split half. Its own occurrence (27 Oct) was deleted, so the row is
      // still live but the schedule it carries starts at the next surviving occurrence.
      tuple({
        id: 'series_j_R20261027T110000',
        seriesId: 'series_j',
        summary: 'Current title',
        start: '2026-10-27T11:00:00.000Z',
        end: '2026-10-27T11:30:00.000Z',
        starts: ['2026-11-03T11:00:00.000Z', '2026-11-10T11:00:00.000Z'],
      }),
      // A materialised exception after the anchor, which is not in the schedule and stays.
      tuple({
        id: 'series_j_20261117T110000Z',
        seriesId: 'series_j',
        summary: 'Current title',
        start: '2026-11-17T11:00:00.000Z',
        end: '2026-11-17T11:30:00.000Z',
      }),
    ]);

    const out = expandRecurringEvents(events, range);
    expect(out.some((e) => e.startTime.toISOString() === '2026-10-27T11:00:00.000Z')).toBe(false);
    expect(out.map((e) => e.startTime.toISOString())).toEqual([
      '2026-11-03T11:00:00.000Z',
      '2026-11-10T11:00:00.000Z',
      '2026-11-17T11:00:00.000Z',
    ]);
  });

  it('uses the schedule even when the master also carries a rule', () => {
    const events = decode([
      tuple({
        id: 'series_g',
        seriesId: 'series_g',
        start: '2026-10-02T13:00:00.000Z',
        end: '2026-10-02T14:00:00.000Z',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'],
        starts: ['2026-10-16T13:00:00.000Z'],
      }),
    ]);

    // The schedule alone, not every Friday the rule would give: an occurrence Google cancelled is
    // simply absent from the list, and walking the rule would re-create it.
    expect(expandRecurringEvents(events, range).map((e) => e.startTime.toISOString())).toEqual([
      '2026-10-16T13:00:00.000Z',
    ]);
  });
});
