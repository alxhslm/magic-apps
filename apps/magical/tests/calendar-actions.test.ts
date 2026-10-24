import { describe, it, expect, vi } from 'vitest';
import type { WebContentsView } from 'electron';
import {
  FallbackCalendarActionDriver,
  type CalendarActionDriver,
  type CalendarActionOutcome,
  type DomActionHost,
} from '../src/calendar-actions/index.js';

describe('FallbackCalendarActionDriver', () => {
  const fakeView = {} as WebContentsView;
  const startTime = new Date();

  it('prefers syncDriver when it returns ok for RSVP', async () => {
    const syncDriver: CalendarActionDriver = {
      performRsvp: vi.fn().mockResolvedValue('ok' as CalendarActionOutcome),
      deleteEvent: vi.fn(),
      setTaskCompleted: vi.fn(),
    };
    const domDriver: CalendarActionDriver = {
      performRsvp: vi.fn().mockResolvedValue('failed' as CalendarActionOutcome),
      deleteEvent: vi.fn(),
      setTaskCompleted: vi.fn(),
    };

    const fallbackDriver = new FallbackCalendarActionDriver(syncDriver, domDriver);
    const outcome = await fallbackDriver.performRsvp(
      fakeView,
      'acc-1',
      'eid-123',
      'yes',
      startTime,
    );

    expect(outcome).toBe('ok');
    expect(syncDriver.performRsvp).toHaveBeenCalledTimes(1);
    expect(domDriver.performRsvp).not.toHaveBeenCalled();
  });

  it('falls back to domDriver when syncDriver returns failed for RSVP', async () => {
    const syncDriver: CalendarActionDriver = {
      performRsvp: vi.fn().mockResolvedValue('failed' as CalendarActionOutcome),
      deleteEvent: vi.fn(),
      setTaskCompleted: vi.fn(),
    };
    const domDriver: CalendarActionDriver = {
      performRsvp: vi.fn().mockResolvedValue('ok' as CalendarActionOutcome),
      deleteEvent: vi.fn(),
      setTaskCompleted: vi.fn(),
    };

    const fallbackDriver = new FallbackCalendarActionDriver(syncDriver, domDriver);
    const outcome = await fallbackDriver.performRsvp(fakeView, 'acc-1', 'eid-123', 'no', startTime);

    expect(outcome).toBe('ok');
    expect(syncDriver.performRsvp).toHaveBeenCalledTimes(1);
    expect(domDriver.performRsvp).toHaveBeenCalledTimes(1);
  });

  it('falls back to domDriver when syncDriver throws for RSVP', async () => {
    const syncDriver: CalendarActionDriver = {
      performRsvp: vi.fn().mockRejectedValue(new Error('Network error')),
      deleteEvent: vi.fn(),
      setTaskCompleted: vi.fn(),
    };
    const domDriver: CalendarActionDriver = {
      performRsvp: vi.fn().mockResolvedValue('ok' as CalendarActionOutcome),
      deleteEvent: vi.fn(),
      setTaskCompleted: vi.fn(),
    };

    const fallbackDriver = new FallbackCalendarActionDriver(syncDriver, domDriver);
    const outcome = await fallbackDriver.performRsvp(
      fakeView,
      'acc-1',
      'eid-123',
      'maybe',
      startTime,
    );

    expect(outcome).toBe('ok');
    expect(syncDriver.performRsvp).toHaveBeenCalledTimes(1);
    expect(domDriver.performRsvp).toHaveBeenCalledTimes(1);
  });

  it('propagates busy outcome directly without falling back', async () => {
    const syncDriver: CalendarActionDriver = {
      performRsvp: vi.fn().mockResolvedValue('busy' as CalendarActionOutcome),
      deleteEvent: vi.fn(),
      setTaskCompleted: vi.fn(),
    };
    const domDriver: CalendarActionDriver = {
      performRsvp: vi.fn(),
      deleteEvent: vi.fn(),
      setTaskCompleted: vi.fn(),
    };

    const fallbackDriver = new FallbackCalendarActionDriver(syncDriver, domDriver);
    const outcome = await fallbackDriver.performRsvp(
      fakeView,
      'acc-1',
      'eid-123',
      'yes',
      startTime,
    );

    expect(outcome).toBe('busy');
    expect(domDriver.performRsvp).not.toHaveBeenCalled();
  });

  it('falls back to domDriver for deleteEvent when syncDriver fails', async () => {
    const syncDriver: CalendarActionDriver = {
      performRsvp: vi.fn(),
      deleteEvent: vi.fn().mockResolvedValue('failed' as CalendarActionOutcome),
      setTaskCompleted: vi.fn(),
    };
    const domDriver: CalendarActionDriver = {
      performRsvp: vi.fn(),
      deleteEvent: vi.fn().mockResolvedValue('ok' as CalendarActionOutcome),
      setTaskCompleted: vi.fn(),
    };

    const fallbackDriver = new FallbackCalendarActionDriver(syncDriver, domDriver);
    const outcome = await fallbackDriver.deleteEvent(
      fakeView,
      'acc-1',
      'eid-123',
      startTime,
      false,
    );

    expect(outcome).toBe('ok');
    expect(syncDriver.deleteEvent).toHaveBeenCalledTimes(1);
    expect(domDriver.deleteEvent).toHaveBeenCalledTimes(1);
  });

  it('falls back to domDriver for setTaskCompleted when syncDriver fails', async () => {
    const syncDriver: CalendarActionDriver = {
      performRsvp: vi.fn(),
      deleteEvent: vi.fn(),
      setTaskCompleted: vi.fn().mockResolvedValue('failed' as CalendarActionOutcome),
    };
    const domDriver: CalendarActionDriver = {
      performRsvp: vi.fn(),
      deleteEvent: vi.fn(),
      setTaskCompleted: vi.fn().mockResolvedValue('ok' as CalendarActionOutcome),
    };

    const fallbackDriver = new FallbackCalendarActionDriver(syncDriver, domDriver);
    const outcome = await fallbackDriver.setTaskCompleted(
      fakeView,
      'acc-1',
      'task-123',
      startTime,
      true,
    );

    expect(outcome).toBe('ok');
    expect(syncDriver.setTaskCompleted).toHaveBeenCalledTimes(1);
    expect(domDriver.setTaskCompleted).toHaveBeenCalledTimes(1);
  });
});

describe('DomCalendarActionDriver', () => {
  const startTime = new Date();

  // Enough of a view for the page to be read: the driver asks it for its URL and
  // scripts it, and nothing here gets as far as a real interaction.
  const fakeView = {
    webContents: {
      getURL: () => 'https://calendar.google.com/calendar/u/0/r/day',
      executeJavaScript: async () => null,
    },
  } as unknown as WebContentsView;

  const host = (overrides: Partial<DomActionHost> = {}): DomActionHost => ({
    hasAccount: () => true,
    activeAccountId: () => 'acc-1',
    viewMode: () => 'calendar',
    viewFor: () => undefined,
    withActionLock: (_accountId, _label, run) => run(),
    wake: async () => ({ view: fakeView, release: () => {} }),
    waitForPage: async () => true,
    ...overrides,
  });

  it('runs an RSVP under the account’s own lock label', async () => {
    const withActionLock = vi.fn(
      (_accountId: string, _label: string, run: () => Promise<unknown>) => run(),
    );
    const { DomCalendarActionDriver } = await import('../src/calendar-actions/dom-driver.js');
    const driver = new DomCalendarActionDriver(host({ withActionLock }));

    await driver.performRsvp(undefined, 'acc-1', 'eid-1', 'yes', startTime);

    expect(withActionLock).toHaveBeenCalledWith('acc-1', 'rsvp:yes', expect.any(Function));
  });

  it('fails without waking a view when the account is gone', async () => {
    const wake = vi.fn();
    const { DomCalendarActionDriver } = await import('../src/calendar-actions/dom-driver.js');
    const driver = new DomCalendarActionDriver(host({ hasAccount: () => false, wake }));

    expect(await driver.deleteEvent(undefined, 'acc-1', 'eid-1', startTime, true)).toBe('failed');
    expect(wake).not.toHaveBeenCalled();
  });

  it('fails every action when the view cannot be woken', async () => {
    const { DomCalendarActionDriver } = await import('../src/calendar-actions/dom-driver.js');
    const driver = new DomCalendarActionDriver(host({ wake: async () => undefined }));

    expect(await driver.performRsvp(undefined, 'acc-1', 'eid-1', 'no', startTime)).toBe('failed');
    expect(await driver.deleteEvent(undefined, 'acc-1', 'eid-1', startTime)).toBe('failed');
    expect(await driver.setTaskCompleted(undefined, 'acc-1', 'eid-1', startTime, true)).toBe(
      'failed',
    );
    expect(await driver.revealEvent(undefined, 'acc-1', 'eid-1', startTime)).toBe('failed');
  });
});
