import { describe, it, expect, vi } from 'vitest';
import { buildAlertContent, formatLead, formatSyncAge } from '../src/notification-manager';
import type { ScheduledAlert } from '../src/alert-scheduler';
import type { NormalizedCalendarEvent } from '../src/calendar-decoder';

vi.mock('../src/swift-helper.js', () => ({
  sendToHelper: vi.fn(),
  isHelperAvailable: () => false,
}));

const alert = (event: Partial<NormalizedCalendarEvent>, leadMinutes = 5): ScheduledAlert => ({
  key: 'k',
  sourceId: 'src',
  leadMinutes,
  fireAt: new Date('2026-09-15T08:55:00Z'),
  event: {
    id: 'evt',
    calendarIds: ['me@work.com'],
    summary: 'Standup',
    webUrl: '',
    created: null,
    updated: null,
    startTime: new Date('2026-09-15T09:00:00Z'),
    endTime: new Date('2026-09-15T09:30:00Z'),
    isAllDay: false,
    myResponseStatus: 3,
    attendees: [],
    reminders: 'unknown',
    ...event,
  },
});

describe('formatLead', () => {
  it('reads naturally at each lead time the settings offer', () => {
    expect(formatLead(1)).toBe('In 1 minute');
    expect(formatLead(10)).toBe('In 10 minutes');
    expect(formatLead(0)).toBe('Starting now');
  });
});

describe('buildAlertContent', () => {
  it('puts the meeting name in the title, since that identifies the alert', () => {
    expect(buildAlertContent(alert({})).title).toBe('Standup');
  });

  it('names the call provider when there is one', () => {
    expect(
      buildAlertContent(alert({ conferenceUrl: 'https://teams.microsoft.com/l/meetup-join/x' }))
        .body,
    ).toBe('Microsoft Teams');
    expect(buildAlertContent(alert({ conferenceUrl: 'https://meet.google.com/abc' })).body).toBe(
      'Google Meet',
    );
  });

  it('falls back to the location, then to nothing', () => {
    expect(buildAlertContent(alert({ location: 'Meeting Room 3B' })).body).toBe('Meeting Room 3B');
    expect(buildAlertContent(alert({})).body).toBe('');
  });

  it('never leaves an untitled meeting blank', () => {
    expect(buildAlertContent(alert({ summary: '' })).title).toBe('(No title)');
  });
});

describe('an alert fired from a calendar that has stopped reading', () => {
  const MINUTE = 60_000;

  it('says how old the calendar behind it is', () => {
    const body = buildAlertContent(alert({}), 25 * MINUTE).body;
    expect(body).toContain('Calendar last synced 25 minutes ago');
  });

  it('carries a warning mark, so the caveat reads at a glance', () => {
    expect(buildAlertContent(alert({}), 25 * MINUTE).body.startsWith('\u26A0\uFE0E')).toBe(true);
  });

  it('says it instead of the location, not alongside it', () => {
    // Whether the meeting is still happening matters more than where it is, and macOS
    // gives a banner one body line to say it in.
    const body = buildAlertContent(alert({ location: 'Meeting Room 3B' }), 40 * MINUTE).body;
    expect(body).toContain('Calendar last synced');
    expect(body).not.toContain('Meeting Room 3B');
  });

  it('leaves an ordinary alert untouched', () => {
    // Nothing is added while the source is reading, which is almost always. A caveat on
    // every banner is noise, and noise is what stops people reading the one that matters.
    expect(buildAlertContent(alert({ location: 'Meeting Room 3B' })).body).toBe('Meeting Room 3B');
    expect(buildAlertContent(alert({})).body).toBe('');
  });
});

describe('formatSyncAge', () => {
  it('counts in minutes up to the hour', () => {
    expect(formatSyncAge(25 * 60_000)).toBe('25 minutes ago');
    expect(formatSyncAge(59 * 60_000)).toBe('59 minutes ago');
  });

  it('rounds to hours beyond that, since nobody is timing it', () => {
    expect(formatSyncAge(60 * 60_000)).toBe('about an hour ago');
    expect(formatSyncAge(3 * 60 * 60_000)).toBe('about 3 hours ago');
  });
});
