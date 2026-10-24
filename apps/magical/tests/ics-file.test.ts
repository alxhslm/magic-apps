import { describe, it, expect } from 'vitest';
import { describeIcs, parseIcsDate, summariseIcs } from '../src/ics-file.js';

const invite = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Example//EN',
  'BEGIN:VEVENT',
  'UID:1@example.com',
  'DTSTART:20260918T140000Z',
  'DTEND:20260918T150000Z',
  'SUMMARY:Dentist Appointment',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('summariseIcs', () => {
  it('reads the title and start of a single invitation', () => {
    const summary = summariseIcs(invite);
    expect(summary.eventCount).toBe(1);
    expect(summary.title).toBe('Dentist Appointment');
    expect(summary.startsAt?.toISOString()).toBe('2026-09-18T14:00:00.000Z');
  });

  it('counts every event in a multi-event file', () => {
    const many = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:First',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'SUMMARY:Second',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'SUMMARY:Third',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(summariseIcs(many).eventCount).toBe(3);
  });

  it('takes the title from the first event only', () => {
    const many = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:First',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'SUMMARY:Second',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(summariseIcs(many).title).toBe('First');
  });

  it('ignores a calendar-level summary outside any event', () => {
    const feed = [
      'BEGIN:VCALENDAR',
      'SUMMARY:Alex’s Public Calendar',
      'BEGIN:VEVENT',
      'SUMMARY:Standup',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(summariseIcs(feed).title).toBe('Standup');
  });

  it('rejoins a folded title', () => {
    const folded = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:Quarterly planning offsite with the whole ',
      ' engineering team',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(summariseIcs(folded).title).toBe(
      'Quarterly planning offsite with the whole engineering team',
    );
  });

  it('strips iCalendar escaping from the title', () => {
    const escaped = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:Review\\, then lunch\\; bring notes',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    expect(summariseIcs(escaped).title).toBe('Review, then lunch; bring notes');
  });

  it('reads a property with parameters between the name and the colon', () => {
    const parameterised = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY;LANGUAGE=en-GB:Board meeting',
      'DTSTART;VALUE=DATE:20261120',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const summary = summariseIcs(parameterised);
    expect(summary.title).toBe('Board meeting');
    expect(summary.startsAt?.getFullYear()).toBe(2026);
  });

  it('reads a file that uses bare newlines rather than CRLF', () => {
    expect(summariseIcs(invite.replace(/\r\n/g, '\n')).title).toBe('Dentist Appointment');
  });

  it('reports nothing rather than throwing on a file that is not iCalendar at all', () => {
    const summary = summariseIcs('just some text\nwith no structure');
    expect(summary.eventCount).toBe(0);
    expect(summary.title).toBeUndefined();
  });

  it('counts an event whose END is missing, as Google does', () => {
    const truncated = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Cut short'].join('\r\n');
    expect(summariseIcs(truncated).eventCount).toBe(1);
  });
});

describe('parseIcsDate', () => {
  it('reads a UTC date-time', () => {
    expect(parseIcsDate('20260918T140000Z')?.toISOString()).toBe('2026-09-18T14:00:00.000Z');
  });

  it('reads a date-only value as local midnight', () => {
    const date = parseIcsDate('20261120');
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(10);
    expect(date?.getDate()).toBe(20);
    expect(date?.getHours()).toBe(0);
  });

  it('returns undefined for a value it does not recognise', () => {
    expect(parseIcsDate('not a date')).toBeUndefined();
  });
});

describe('describeIcs', () => {
  it('names the event and when it starts', () => {
    const text = describeIcs(summariseIcs(invite), 'invite.ics');
    expect(text).toContain('Dentist Appointment');
  });

  it('counts the events instead when the file holds several', () => {
    const summary = { eventCount: 12, title: 'First' };
    expect(describeIcs(summary, 'term-dates.ics')).toBe('12 events from “term-dates.ics”');
  });

  it('falls back to the file name when the event has no title', () => {
    expect(describeIcs({ eventCount: 1 }, 'meeting.ics')).toBe('“meeting.ics”');
  });
});
