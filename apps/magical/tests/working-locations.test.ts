import { describe, expect, it } from 'vitest';

import { EVENT_TYPE, type NormalizedCalendarEvent } from '../src/calendar-decoder.js';
import { collapseWorkingLocations } from '../src/working-locations.js';

/** An all-day entry on 23 September, which is the day the fixtures collide on. */
const entry = (over: Partial<NormalizedCalendarEvent> & { id: string }): NormalizedCalendarEvent =>
  ({
    calendarIds: ['me@work.com'],
    summary: 'Home',
    webUrl: '',
    created: new Date('2025-12-08T09:21:38Z'),
    updated: new Date('2025-12-08T09:21:39Z'),
    startTime: new Date('2026-09-23T00:00:00Z'),
    endTime: new Date('2026-09-24T00:00:00Z'),
    isAllDay: true,
    eventType: EVENT_TYPE.WORKING_LOCATION,
    attendees: [],
    myResponseStatus: 'notInvited',
    reminders: { overrides: [], useDefault: true },
    ...over,
  }) as NormalizedCalendarEvent;

/** The weekly "Home" the expander generates for that Wednesday. */
const recurring = entry({
  id: 'mllra19v5pk85uhahrp6di7atg_R20260923T000000',
  seriesId: 'mllra19v5pk85uhahrp6di7atg',
  recurrenceRule: 'RRULE:FREQ=WEEKLY;BYDAY=WE',
});

/** The location the user set for that day alone. */
const oneOff = entry({
  id: 'm58dvk0cehuvqn24t9b51sdsec',
  summary: 'test',
  eventType: EVENT_TYPE.WORKING_LOCATION_ONE_OFF,
  updated: new Date('2026-09-22T17:29:32Z'),
});

const ids = (events: NormalizedCalendarEvent[]) => events.map((e) => e.id);

describe('collapsing a day to one working location', () => {
  it('keeps the one the user set for that day, and drops the series underneath it', () => {
    // Google leaves both live and carries no exclusion on the series, so the two arrive
    // together; drawn as they come, the day says the user is in two places.
    expect(ids(collapseWorkingLocations([recurring, oneOff]))).toEqual([oneOff.id]);
  });

  it('does not care which order they arrived in', () => {
    expect(ids(collapseWorkingLocations([oneOff, recurring]))).toEqual([oneOff.id]);
  });

  it('keeps the series occurrence on a day the user has not overridden', () => {
    expect(ids(collapseWorkingLocations([recurring]))).toEqual([recurring.id]);
  });

  it('takes the later of two the user set for the same day', () => {
    const earlier = entry({
      id: 'earlier',
      summary: 'first go',
      eventType: EVENT_TYPE.WORKING_LOCATION_ONE_OFF,
      updated: new Date('2026-09-22T09:00:00Z'),
    });
    expect(ids(collapseWorkingLocations([oneOff, earlier]))).toEqual([oneOff.id]);
  });

  it('leaves a working location on another day alone', () => {
    const thursday = entry({
      id: 'thursday',
      summary: 'Office',
      startTime: new Date('2026-09-24T00:00:00Z'),
      endTime: new Date('2026-09-25T00:00:00Z'),
    });
    expect(ids(collapseWorkingLocations([recurring, oneOff, thursday])).sort()).toEqual(
      [oneOff.id, thursday.id].sort(),
    );
  });

  it('leaves entries carrying a time alone', () => {
    // A working location given a time is an appointment like any other, and Google draws
    // it as one. Only the all-day entry states where the day is spent.
    const morning = entry({
      id: 'morning',
      isAllDay: false,
      startTime: new Date('2026-09-23T08:00:00Z'),
      endTime: new Date('2026-09-23T12:00:00Z'),
      eventType: EVENT_TYPE.WORKING_LOCATION_ONE_OFF,
    });
    const afternoon = entry({
      id: 'afternoon',
      summary: 'Office',
      isAllDay: false,
      startTime: new Date('2026-09-23T13:00:00Z'),
      endTime: new Date('2026-09-23T17:00:00Z'),
      eventType: EVENT_TYPE.WORKING_LOCATION_ONE_OFF,
    });
    expect(ids(collapseWorkingLocations([morning, afternoon])).sort()).toEqual(
      ['afternoon', 'morning'].sort(),
    );
  });
});

describe('what the collapse must not touch', () => {
  it('keeps two ordinary all-day events on the same day', () => {
    // The rule is about working locations alone. Two all-day events on one day are
    // ordinary, and a general duplicate rule would eat one of them.
    const holiday = entry({
      id: 'holiday',
      summary: 'Bank holiday',
      eventType: EVENT_TYPE.DEFAULT,
    });
    const offsite = entry({
      id: 'offsite',
      summary: 'Team offsite',
      eventType: EVENT_TYPE.DEFAULT,
    });
    expect(ids(collapseWorkingLocations([holiday, offsite])).sort()).toEqual(
      ['holiday', 'offsite'].sort(),
    );
  });

  it('keeps a birthday and a task sharing the day with a working location', () => {
    const birthday = entry({
      id: 'bday',
      summary: "Colleague's birthday",
      eventType: EVENT_TYPE.BIRTHDAY,
    });
    const task = entry({ id: 'task', summary: 'Write the RFC', eventType: EVENT_TYPE.TASK });
    expect(ids(collapseWorkingLocations([recurring, oneOff, birthday, task])).sort()).toEqual(
      [oneOff.id, 'bday', 'task'].sort(),
    );
  });

  it('returns the list untouched when no working location is in it', () => {
    const meeting = entry({
      id: 'meeting',
      summary: 'Sprint planning',
      isAllDay: false,
      eventType: EVENT_TYPE.DEFAULT,
    });
    expect(collapseWorkingLocations([meeting])).toEqual([meeting]);
  });
});
