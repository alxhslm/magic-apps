import { describe, it, expect } from 'vitest';
import type { CalendarAccount } from '../src/accounts.js';
import type { NormalizedCalendarEvent } from '../src/calendar-decoder.js';
import {
  buildSerializedCalendars,
  resolveCanonicalCalendarId,
  friendlyCalendarName,
  pollableCalendarIds,
  GOOGLE_CALENDAR_DEFAULT_SWATCHES,
} from '../src/calendars.js';

describe('calendars', () => {
  describe('friendlyCalendarName', () => {
    it('cleans up well-known Google calendar IDs', () => {
      expect(friendlyCalendarName('contacts@group.v.calendar.google.com')).toBe('Birthdays');
      expect(friendlyCalendarName('family12345@group.calendar.google.com')).toBe('Family');
      expect(friendlyCalendarName('en.uk#holiday@group.v.calendar.google.com')).toBe('UK Holidays');
      expect(friendlyCalendarName('colleague.smith@work.com')).toBe('Colleague Smith');
      expect(friendlyCalendarName('project-team@group.calendar.google.com')).toBe(
        'Shared Calendar',
      );
      expect(friendlyCalendarName('custom_id')).toBe('custom_id');
    });
  });

  describe('pollableCalendarIds', () => {
    const cal = (id: string) => ({ id, name: id, color: '#000' });
    const account = (over: Partial<CalendarAccount> = {}): CalendarAccount => ({
      id: 'acc_1',
      name: 'Work',
      partition: 'persist:work',
      color: '#3b82f6',
      ...over,
    });

    it("drops a colleague's calendar the account only ever looked at", () => {
      // Google's own client names a colleague when the user searches for them or opens
      // "Meet with", and every id it names is recorded against the account.
      const ids = pollableCalendarIds(
        account({
          calendarIds: ['me@work.com', 'colleague@work.com'],
          calendars: [cal('me@work.com')],
        }),
      );
      expect(ids).toEqual(['me@work.com']);
    });

    it("keeps a colleague's calendar the account actually subscribes to", () => {
      const ids = pollableCalendarIds(
        account({
          calendarIds: ['me@work.com', 'colleague@work.com'],
          calendars: [cal('me@work.com'), cal('colleague@work.com')],
        }),
      );
      expect(ids).toContain('colleague@work.com');
    });

    it("keeps shared, imported and holiday calendars, which are nobody's mailbox", () => {
      const shared = 'team@group.calendar.google.com';
      const imported = 'abc@import.calendar.google.com';
      const holidays = 'en-gb.uk#holiday@group.v.calendar.google.com';
      expect(
        pollableCalendarIds(
          account({
            calendarIds: ['me@work.com', shared, imported, holidays],
            calendars: [cal('me@work.com')],
          }),
        ),
      ).toEqual(['me@work.com', shared, imported, holidays]);
    });

    it('drops a meeting room the account booked but does not subscribe to', () => {
      // Booking a room names it in a range request, exactly as searching for a colleague
      // does. Polling it brought every booking anybody made in that room into the
      // agenda, under its raw id and with no colour.
      const room = 'c_example_room_001@resource.calendar.google.com';
      const ids = pollableCalendarIds(
        account({
          calendarIds: ['me@work.com', room],
          calendars: [cal('me@work.com')],
        }),
      );
      expect(ids).toEqual(['me@work.com']);
    });

    it('keeps a meeting room the account subscribes to', () => {
      const room = 'c_example_room_001@resource.calendar.google.com';
      const ids = pollableCalendarIds(
        account({
          calendarIds: ['me@work.com', room],
          calendars: [cal('me@work.com'), cal(room)],
        }),
      );
      expect(ids).toContain(room);
    });

    it('drops the two calendars that never return a block of their own', () => {
      const ids = pollableCalendarIds(
        account({
          calendarIds: ['me@work.com', 'tasks@tasks.google.com', 'birthdays@birthdays.google.com'],
          calendars: [cal('me@work.com')],
        }),
      );
      expect(ids).toEqual(['me@work.com']);
    });

    it('drops those two even with no calendar list to judge against', () => {
      const ids = pollableCalendarIds(
        account({ calendarIds: ['me@work.com', 'tasks@tasks.google.com'] }),
      );
      expect(ids).toEqual(['me@work.com']);
    });

    it('drops nobody when the account has no calendar list yet', () => {
      // Without the account's own calendars there is nothing to judge a personal address
      // against, and dropping the user's own calendar would be the worse mistake.
      const ids = pollableCalendarIds(
        account({ calendarIds: ['someone@work.com', 'me@work.com'] }),
      );
      expect(ids).toEqual(['someone@work.com', 'me@work.com']);
    });

    it('asks for nothing at all before the account has ever loaded', () => {
      // A guess would come back as an empty payload, which reads as "no meetings"
      // rather than as an error.
      expect(pollableCalendarIds(account({ calendarIds: [] }))).toEqual([]);
    });
  });

  describe('resolveCanonicalCalendarId', () => {
    const account: CalendarAccount = {
      id: 'acc_1',
      name: 'Work',
      partition: 'persist:work',
      color: '#3b82f6',
      email: 'user@work.com',
      calendarIds: ['user@work.com', 'team@group.calendar.google.com'],
    };

    it('resolves primary, account id, and email to the canonical primary email', () => {
      expect(resolveCanonicalCalendarId('primary', account)).toBe('user@work.com');
      expect(resolveCanonicalCalendarId('acc_1', account)).toBe('user@work.com');
      expect(resolveCanonicalCalendarId('user@work.com', account)).toBe('user@work.com');
    });

    it('leaves secondary calendar IDs untouched', () => {
      expect(resolveCanonicalCalendarId('team@group.calendar.google.com', account)).toBe(
        'team@group.calendar.google.com',
      );
    });

    it('returns the calendar ID as-is when account is undefined', () => {
      expect(resolveCanonicalCalendarId('primary', undefined)).toBe('primary');
    });
  });

  describe('buildSerializedCalendars', () => {
    it('uses discovered metadata when present', () => {
      const account: CalendarAccount = {
        id: 'acc_1',
        name: 'Work',
        partition: 'persist:work',
        color: '#3b82f6',
        email: 'user@work.com',
        calendars: [
          { id: 'user@work.com', name: 'Work Primary', color: '#123456' },
          { id: 'secondary_1', name: 'Team Calendar', color: '#654321' },
        ],
      };

      const { calendars, calendarColorMap, calendarNameMap } = buildSerializedCalendars([account]);
      expect(calendars).toHaveLength(2);
      expect(calendars[0]).toEqual({
        id: 'user@work.com',
        accountId: 'acc_1',
        name: 'Work Primary',
        colorHex: '#123456',
      });
      expect(calendars[1]).toEqual({
        id: 'secondary_1',
        accountId: 'acc_1',
        name: 'Team Calendar',
        colorHex: '#654321',
      });

      expect(calendarColorMap.get('acc_1')?.get('primary')).toBe('#123456');
      expect(calendarColorMap.get('acc_1')?.get('user@work.com')).toBe('#123456');
      expect(calendarColorMap.get('acc_1')?.get('secondary_1')).toBe('#654321');
      expect(calendarNameMap.get('acc_1')?.get('primary')).toBe('Work Primary');
    });

    it('falls back to accounts and secondary calendar ids when metadata is not yet synchronized', () => {
      const account: CalendarAccount = {
        id: 'acc_1',
        name: 'Personal',
        partition: 'persist:personal',
        color: '#a855f7',
        email: 'alice@example.com',
        calendarIds: ['alice@example.com', 'en.uk#holiday@group.v.calendar.google.com'],
      };

      const { calendars, calendarColorMap } = buildSerializedCalendars([account]);
      expect(calendars).toHaveLength(2);
      expect(calendars[0].id).toBe('alice@example.com');
      expect(calendars[0].name).toBe('alice@example.com');
      expect(calendars[0].colorHex).toBe('#a855f7');

      expect(calendars[1].id).toBe('en.uk#holiday@group.v.calendar.google.com');
      expect(calendars[1].name).toBe('UK Holidays');
      expect(calendars[1].colorHex).toBe(GOOGLE_CALENDAR_DEFAULT_SWATCHES[0]);
      expect(calendarColorMap.get('acc_1')?.get('alice@example.com')).toBe('#a855f7');
    });

    it('enriches calendar names from events when metadata is absent', () => {
      const account: CalendarAccount = {
        id: 'acc_1',
        name: 'Personal',
        partition: 'persist:personal',
        color: '#a855f7',
        email: 'alice@example.com',
        calendarIds: ['alice@example.com', 'cal_extra'],
      };

      const eventsMap = new Map<string, NormalizedCalendarEvent[]>([
        [
          'acc_1',
          [
            {
              id: 'evt_1',
              calendarIds: ['cal_extra'],
              calendarName: 'Enriched Project Name',
              summary: 'Meeting',
              startTime: new Date('2026-06-01T10:00:00Z'),
              endTime: new Date('2026-06-01T11:00:00Z'),
              isAllDay: false,
              myResponseStatus: 0,
            } as NormalizedCalendarEvent,
          ],
        ],
      ]);

      const { calendars, calendarNameMap } = buildSerializedCalendars([account], eventsMap);
      const extra = calendars.find((c) => c.id === 'cal_extra');
      expect(extra?.name).toBe('Enriched Project Name');
      expect(calendarNameMap.get('acc_1')?.get('cal_extra')).toBe('Enriched Project Name');
    });

    it('keeps two accounts’ same-id calendars apart', () => {
      // Google gives Birthdays and each locale's holidays the same id in every account.
      // A flat map let the last account processed name and paint both accounts' events.
      const shared = 'birthdays@birthdays.google.com';
      const personal: CalendarAccount = {
        id: 'acc_personal',
        name: 'Personal',
        partition: 'persist:personal',
        color: '#a855f7',
        email: 'alice@example.com',
        calendars: [{ id: shared, name: 'Birthdays', color: '#828BC2' }],
      };
      const work: CalendarAccount = {
        id: 'acc_work',
        name: 'Work',
        partition: 'persist:work',
        color: '#3b82f6',
        email: 'alice@work.com',
        calendars: [{ id: shared, name: 'Birthdays', color: '#55B080' }],
      };

      const { calendars, calendarColorMap, calendarNameMap } = buildSerializedCalendars([
        personal,
        work,
      ]);

      expect(calendars.filter((c) => c.id === shared)).toHaveLength(2);
      expect(calendarColorMap.get('acc_personal')?.get(shared)).toBe('#828BC2');
      expect(calendarColorMap.get('acc_work')?.get(shared)).toBe('#55B080');
      expect(calendarNameMap.get('acc_work')?.get(shared)).toBe('Birthdays');
    });
  });
});
