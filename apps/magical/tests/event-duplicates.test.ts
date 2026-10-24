import { describe, it, expect } from 'vitest';
import {
  findDuplicateMeetings,
  duplicateMeetingKey,
  duplicateMeetingWarning,
} from '../src/event-duplicates.js';
import type { NormalizedCalendarEvent } from '../src/calendar-decoder.js';

function event(partial: Partial<NormalizedCalendarEvent>): NormalizedCalendarEvent {
  return {
    id: partial.id ?? 'evt',
    calendarIds: partial.calendarIds ?? ['cal'],
    summary: partial.summary ?? 'Meeting',
    webUrl: '',
    created: null,
    updated: null,
    startTime: partial.startTime ?? new Date('2026-10-02T09:00:00.000Z'),
    endTime: partial.endTime ?? new Date('2026-10-02T09:30:00.000Z'),
    isAllDay: false,
    attendees: [],
    eventType: 0,
    myResponseStatus: 'notInvited',
    reminders: 'unknown',
    ...partial,
  };
}

describe('finding one meeting the agenda holds twice', () => {
  it('groups a master and its materialised occurrence by uid and start', () => {
    const uid = 'series@google.com';
    const start = new Date('2026-10-07T09:40:00.000Z');
    const dupe = findDuplicateMeetings([
      event({ id: 'series', uid, startTime: start }),
      event({ id: 'series_20261007T094000Z', seriesId: 'series', uid, startTime: start }),
    ]);
    expect(dupe).toHaveLength(1);
    expect(dupe[0].events).toHaveLength(2);
  });

  it('does not group two occurrences of one series at different starts', () => {
    const uid = 'series@google.com';
    expect(
      findDuplicateMeetings([
        event({ id: 'a', uid, startTime: new Date('2026-10-07T09:40:00.000Z') }),
        event({ id: 'b', uid, startTime: new Date('2026-10-08T09:40:00.000Z') }),
      ]),
    ).toHaveLength(0);
  });

  it('leaves two unrelated meetings that share a title and slot alone', () => {
    // Three candidates really can share one interview slot and one generic title.
    expect(
      findDuplicateMeetings([
        event({
          id: 'candidate-a',
          summary: 'Interview',
          startTime: new Date('2026-10-02T12:00:00.000Z'),
        }),
        event({
          id: 'candidate-b',
          summary: 'Interview',
          startTime: new Date('2026-10-02T12:00:00.000Z'),
        }),
      ]),
    ).toHaveLength(0);
  });

  it('falls back to seriesId, then id, when the wire sent no uid', () => {
    const start = new Date('2026-10-07T09:40:00.000Z');
    expect(
      findDuplicateMeetings([
        event({ id: 'series_20261007T094000Z', seriesId: 'series', startTime: start }),
        event({ id: 'series_R20261007T094000', seriesId: 'series', startTime: start }),
      ]),
    ).toHaveLength(1);
  });

  it('keys a meeting by its identity, not its title', () => {
    expect(duplicateMeetingKey(event({ id: 'a', summary: 'One', myResponseStatus: 0 }))).toBe(
      duplicateMeetingKey(event({ id: 'a', summary: 'Renamed', myResponseStatus: 3 })),
    );
  });

  it('writes a warning with no title and no id', () => {
    const start = new Date('2026-10-02T09:40:00.000Z');
    const group = [
      event({
        id: 'series_20261002T084000Z',
        seriesId: 'series',
        summary: 'Client stand-up',
        startTime: start,
      }),
      event({
        id: 'series_R20261002T084000',
        seriesId: 'series',
        summary: 'Client stand-up',
        startTime: start,
      }),
    ];

    const line = duplicateMeetingWarning('account_x', group);
    expect(line).toContain('account_x');
    expect(line).toContain('2 entries');
    expect(line).toContain('2026-10-02T09:40:00.000Z');
    // The log leaves the machine in a bug report; the title and the ids must not.
    expect(line).not.toContain('Client stand-up');
    expect(line).not.toContain('series_20261002T084000Z');
    expect(line).not.toContain('series_R20261002T084000');
  });
});
