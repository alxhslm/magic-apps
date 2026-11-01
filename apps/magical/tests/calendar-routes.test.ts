import { describe, it, expect } from 'vitest';
import { parseCalendarRoute, viewModeForPath, calendarRoot } from '../src/calendar-routes.js';

describe('calendar-routes', () => {
  describe('parseCalendarRoute', () => {
    it('parses month view route with date', () => {
      const result = parseCalendarRoute(
        'https://calendar.google.com/calendar/u/0/r/month/2026/10/1',
      );
      expect(result).toEqual({
        timeframe: 'month',
        dateStr: '2026-10-01',
      });
    });

    it('parses week view route with date', () => {
      const result = parseCalendarRoute('/calendar/u/0/r/week/2026/9/14');
      expect(result).toEqual({
        timeframe: 'week',
        dateStr: '2026-09-14',
      });
    });

    it('parses day view route with date', () => {
      const result = parseCalendarRoute('https://calendar.google.com/calendar/u/1/r/day/2026/11/5');
      expect(result).toEqual({
        timeframe: 'day',
        dateStr: '2026-11-05',
      });
    });

    it('parses year view route', () => {
      const result = parseCalendarRoute('/calendar/u/0/r/year/2026/1/1');
      expect(result).toEqual({
        timeframe: 'year',
        dateStr: '2026-01-01',
      });
    });

    it('parses agenda / schedule routes', () => {
      expect(parseCalendarRoute('/calendar/u/0/r/agenda')).toEqual({
        timeframe: 'agenda',
        dateStr: undefined,
      });
      expect(parseCalendarRoute('/calendar/u/0/r/schedule')).toEqual({
        timeframe: 'schedule',
        dateStr: undefined,
      });
    });

    it('parses customday route', () => {
      const result = parseCalendarRoute('/calendar/u/0/r/customday/2026/8/20');
      expect(result).toEqual({
        timeframe: 'customday',
        dateStr: '2026-08-20',
      });
    });

    it('defaults to month for root calendar route', () => {
      expect(parseCalendarRoute('/calendar/u/0/r')).toEqual({
        timeframe: 'month',
        dateStr: undefined,
      });
      expect(parseCalendarRoute('https://calendar.google.com/calendar/u/1/r/')).toEqual({
        timeframe: 'month',
        dateStr: undefined,
      });
    });

    it('returns null for non-timeframe URLs', () => {
      expect(parseCalendarRoute(null)).toBeNull();
      expect(parseCalendarRoute('https://calendar.google.com/calendar/u/0/r/tasks')).toBeNull();
      expect(parseCalendarRoute('https://calendar.google.com/calendar/u/0/r/settings')).toBeNull();
      expect(parseCalendarRoute('https://mail.google.com/mail/u/0')).toBeNull();
    });
  });

  describe('viewModeForPath', () => {
    it('detects tasks route', () => {
      expect(viewModeForPath('/calendar/u/0/r/tasks')).toBe('tasks');
      expect(viewModeForPath('/calendar/u/0/r/tasks/')).toBe('tasks');
    });

    it('detects calendar route', () => {
      expect(viewModeForPath('/calendar/u/0/r/week')).toBe('calendar');
      expect(viewModeForPath('/calendar/u/0/r/tasksomething')).toBe('calendar');
    });
  });

  describe('calendarRoot', () => {
    it('extracts calendar root with account index', () => {
      expect(calendarRoot('/calendar/u/2/r/week/2026/9/1')).toBe('/calendar/u/2/r');
      expect(calendarRoot(null)).toBe('/calendar/u/0/r');
    });
  });
});
