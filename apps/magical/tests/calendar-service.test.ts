import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EVENT_TYPE, RESPONSE_NEEDS_ACTION } from '../src/calendar-decoder';
import type { NormalizedCalendarEvent } from '../src/calendar-decoder';
import { buildEventLink, extractEid } from '../src/event-links';
import { isAlertable } from '../src/alert-scheduler';
import { calendarAlertKey } from '../src/calendars';

const openExternal = vi.fn();

// A fresh state directory per run. CalendarService persists fired alerts and seen
// invitations to a real file, and a shared path lets one run's state decide the next
// run's badge.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magical-test-'));

vi.mock('electron', () => ({
  app: { getPath: () => stateDir },
  powerMonitor: { on: vi.fn(), isOnBatteryPower: () => false },
  shell: { openExternal: (url: string) => openExternal(url) },
  dialog: { showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })) },
}));

const alwaysJoinInBrowser = vi.fn(() => false);
const dockBadgeMode = vi.fn(() => 'allPending' as 'allPending' | 'newInvitations');
const disabledAlertCalendarIds = vi.fn(() => [] as string[]);
vi.mock('../src/settings-store', () => ({
  loadSettings: () => ({
    meetingAlertsEnabled: true,
    meetingAlertLeadMinutes: 5,
    alwaysJoinInBrowser: alwaysJoinInBrowser(),
    dockBadgeMode: dockBadgeMode(),
    disabledAlertCalendarIds: disabledAlertCalendarIds(),
  }),
}));

const updateDockBadge = vi.fn();
vi.mock('../src/dock', () => ({ updateDockBadge: (n: number) => updateDockBadge(n) }));

const hasApplicationForUrl = vi.fn((_url: string) => true);
vi.mock('../src/native-handlers', () => ({
  hasApplicationForUrl: (url: string) => hasApplicationForUrl(url),
}));

const updateToolbarInvites = vi.fn();
vi.mock('../src/native-toolbar', () => ({
  updateNativeToolbarInvites: (invites: unknown[], count?: number) =>
    updateToolbarInvites(invites, count),
}));

class FakeSessionExpiredError extends Error {}
class FakeNetworkError extends Error {}

const pollerEvents = new Map<string, NormalizedCalendarEvent[]>();
/** What each source's next read should throw instead of returning, keyed by source id. */
const pollerFailures = new Map<string, () => Error>();
/** Hook invoked during poller.events to allow tests to delay or coordinate fetches. */
let pollerHook: ((range: { start: Date; end: Date }) => Promise<void> | void) | null = null;
/** Every range the service has asked a poller for, in order. */
const polledRanges: { start: Date; end: Date }[] = [];
vi.mock('../src/calendar-poller', () => ({
  CalendarPoller: class {
    public readonly id: string;
    public lastSuccessfulReadAt: Date | null = null;
    constructor(options: { id: string }) {
      this.id = options.id;
    }
    setCalendarIds(): void {}
    async events(range: { start: Date; end: Date }): Promise<NormalizedCalendarEvent[]> {
      polledRanges.push(range);
      const fail = pollerFailures.get(this.id);
      if (fail) throw fail();
      if (pollerHook) await pollerHook(range);
      this.lastSuccessfulReadAt = new Date();
      return pollerEvents.get(this.id) ?? [];
    }
  },
  classifyFailure: (err: unknown) => {
    if (err instanceof FakeSessionExpiredError) return 'signed-out';
    if (err instanceof FakeNetworkError) return 'offline';
    return 'unreadable';
  },
  CalendarSessionExpiredError: FakeSessionExpiredError,
}));

const { toNativeMeetingUrl, openExternalUrl, truncateTitle, formatInviteWhen, CalendarService } =
  await import('../src/calendar-service');
// Imported the same way, so the service and these tests share one configuration.
const { configureSecretFiles, readSecretFile, resetSecretFiles } = await import('@magimail/core');

// Each test starts with no persisted state. The service writes fired alerts and seen
// invitations to disk, and a test that inherits them is testing the previous test.
beforeEach(() => {
  fs.rmSync(path.join(stateDir, 'alert-state.json'), { force: true });
  fs.rmSync(path.join(stateDir, 'event-cache.json'), { force: true });
  dockBadgeMode.mockReturnValue('allPending');
  disabledAlertCalendarIds.mockReturnValue([]);
  pollerFailures.clear();
  pollerHook = null;
});

function makeService() {
  return new CalendarService(
    () => [],
    () => {},
    async () => 'ok' as const,
  );
}

/**
 * A time relative to the clock the test runs on, which is how every event here is dated.
 * Both the poll and the cache keep a window around today and drop what falls outside it,
 * so an event dated by a fixed string stops arriving once enough real time has passed.
 */
const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000);

describe('toNativeMeetingUrl', () => {
  it('hands Zoom to the desktop app with the meeting number', () => {
    expect(toNativeMeetingUrl('https://zoom.us/j/1234567890')).toBe(
      'zoommtg://zoom.us/join?action=join&confno=1234567890',
    );
  });

  it('carries a Zoom passcode through, so the app does not stop and ask', () => {
    expect(toNativeMeetingUrl('https://acme.zoom.us/j/999?pwd=SeCrEt')).toBe(
      'zoommtg://zoom.us/join?action=join&confno=999&pwd=SeCrEt',
    );
  });

  it('switches Teams to its own scheme', () => {
    expect(toNativeMeetingUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x')).toBe(
      'msteams://teams.microsoft.com/l/meetup-join/19%3ameeting_x',
    );
  });

  it('leaves Google Meet alone, since its web client is the real one', () => {
    const url = 'https://meet.google.com/abc-defg-hij';
    expect(toNativeMeetingUrl(url)).toBe(url);
  });

  it('passes through anything it does not recognise rather than mangling it', () => {
    const url = 'https://example.com/conference/room-7';
    expect(toNativeMeetingUrl(url)).toBe(url);
  });
});

describe('openExternalUrl', () => {
  beforeEach(() => {
    openExternal.mockClear();
    hasApplicationForUrl.mockClear();
    hasApplicationForUrl.mockReturnValue(true);
    alwaysJoinInBrowser.mockReturnValue(false);
  });

  it('unwraps redirector URLs before dispatching to external browser', async () => {
    const raw = 'https://www.google.com/url?q=https://app.todoist.com/app/task/1234567890&usd=1';
    await openExternalUrl(raw);
    expect(openExternal).toHaveBeenCalledWith('https://app.todoist.com/app/task/1234567890');
  });

  it('hands meeting links to desktop app when installed', async () => {
    await openExternalUrl('https://zoom.us/j/1234567890');
    expect(hasApplicationForUrl).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=1234567890',
    );
    expect(openExternal).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=1234567890',
    );
  });

  it('falls back to browser when meeting app is not installed', async () => {
    hasApplicationForUrl.mockReturnValue(false);
    const url = 'https://zoom.us/j/1234567890';
    await openExternalUrl(url);
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it('opens non-meeting external URLs directly in browser', async () => {
    const url = 'https://docs.google.com/document/d/123';
    await openExternalUrl(url);
    expect(hasApplicationForUrl).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(url);
  });
});

describe('joinCall', () => {
  beforeEach(() => {
    openExternal.mockClear();
    hasApplicationForUrl.mockClear();
    hasApplicationForUrl.mockReturnValue(true);
    alwaysJoinInBrowser.mockReturnValue(false);
  });

  it('hands the call to the native app when one is installed', () => {
    void makeService().joinCall('https://zoom.us/j/1234567890');
    expect(hasApplicationForUrl).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=1234567890',
    );
    expect(openExternal).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=1234567890',
    );
  });

  it('opens the browser when nothing is registered for the native scheme', () => {
    hasApplicationForUrl.mockReturnValue(false);
    const url = 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x';
    void makeService().joinCall(url);
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it('never asks about a link it did not rewrite', () => {
    const url = 'https://meet.google.com/abc-defg-hij';
    void makeService().joinCall(url);
    expect(hasApplicationForUrl).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it('keeps the web URL when the user has asked for the browser', () => {
    alwaysJoinInBrowser.mockReturnValue(true);
    const url = 'https://zoom.us/j/1234567890';
    void makeService().joinCall(url);
    expect(hasApplicationForUrl).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it('falls back to the browser when a registered client refuses to launch', async () => {
    const url = 'https://zoom.us/j/1234567890';
    openExternal.mockRejectedValueOnce(new Error('No application found to open URL'));

    await makeService().joinCall(url);

    expect(openExternal).toHaveBeenNthCalledWith(
      1,
      'zoommtg://zoom.us/join?action=join&confno=1234567890',
    );
    expect(openExternal).toHaveBeenNthCalledWith(2, url);
  });

  it('never rejects, since both callers discard the promise', async () => {
    openExternal
      .mockRejectedValueOnce(new Error('No application found to open URL'))
      .mockRejectedValueOnce(new Error('No application found to open URL'));

    await expect(makeService().joinCall('https://zoom.us/j/1234567890')).resolves.toBeUndefined();
  });

  it('routes web calls through openExternalUrl using the matching account', async () => {
    const url = 'https://meet.google.com/abc-defg-hij';
    await makeService().joinCall(url, 'account_work');
    expect(openExternal).toHaveBeenCalledWith(url);
  });
});

describe('openDeepLink', () => {
  const account = { id: 'acct', name: 'Work', partition: 'p', color: '#000' };
  const link = 'magical://event?account=acct&eid=ABC&at=2026-09-15T09%3A00%3A00.000Z';

  function serviceWithReveal(outcome: 'revealed' | 'routed' | 'busy' | 'failed') {
    const navigate = vi.fn();
    const reveal = vi.fn(() => Promise.resolve(outcome));
    const service = new CalendarService(
      () => [account],
      navigate,
      async () => 'ok' as const,
      reveal,
    );
    return { service, navigate, reveal };
  }

  it('reveals the event in place rather than loading a URL', async () => {
    const { service, navigate, reveal } = serviceWithReveal('revealed');

    expect(service.openDeepLink(link)).toBe(true);
    await vi.waitFor(() => expect(reveal).toHaveBeenCalled());

    expect(reveal).toHaveBeenCalledWith('acct', 'ABC', new Date('2026-09-15T09:00:00.000Z'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves an open editor alone rather than navigating out from under it', async () => {
    const { service, navigate, reveal } = serviceWithReveal('busy');

    service.openDeepLink(link);
    await vi.waitFor(() => expect(reveal).toHaveBeenCalled());

    expect(navigate).not.toHaveBeenCalled();
  });

  it('stays on the day when the panel does not open, rather than reloading', async () => {
    const { service, navigate, reveal } = serviceWithReveal('routed');

    service.openDeepLink(link);
    await vi.waitFor(() => expect(reveal).toHaveBeenCalled());

    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves the view alone when the event cannot be reached', async () => {
    const { service, navigate } = serviceWithReveal('failed');

    service.openDeepLink(link);

    // No recovery navigation. The only URL naming an event is the edit form, and a
    // reload of the day the user is already on shows them less than they have.
    await new Promise((r) => setTimeout(r, 50));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('loads the URL for a link naming only a day', () => {
    const { service, navigate, reveal } = serviceWithReveal('revealed');

    service.openDeepLink('magical://date?account=acct&at=2026-09-15T09:00:00.000Z');

    expect(reveal).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('acct', expect.stringContaining('/r/day/2026/9/15'));
  });

  it('opens the window for a link that arrives with no account to resolve against', async () => {
    // No accounts until the window is built; the link must still resolve.
    const reveal = vi.fn(() => Promise.resolve('revealed' as const));
    let openedFor: string | null = null;
    const service = new CalendarService(
      () => (openedFor ? [account] : []),
      vi.fn(),
      async () => 'ok' as const,
      reveal,
      undefined,
      undefined,
      undefined,
      (accountId) => {
        openedFor = accountId;
      },
    );

    expect(service.openDeepLink(link)).toBe(true);
    await vi.waitFor(() => expect(reveal).toHaveBeenCalled());

    expect(openedFor).toBe('acct');
    expect(reveal).toHaveBeenCalledWith('acct', 'ABC', new Date('2026-09-15T09:00:00.000Z'));
  });
});

describe('deleteEvent', () => {
  it('returns false when the event is not found in cached events', async () => {
    const service = makeService();
    const result = await service.deleteEvent('acc1', 'unknown-event');
    expect(result).toBe(false);
  });

  it('optimistically removes the event and calls performDelete', async () => {
    const performDelete = vi.fn().mockResolvedValue('ok' as const);
    let navigatedUrl = '';
    const service = new CalendarService(
      () => [{ id: 'acc1', name: 'Personal', color: '#000', email: 'test@example.com' }],
      (_acc, url) => {
        navigatedUrl = url;
      },
      async () => 'ok' as const,
      undefined,
      undefined,
      performDelete,
    );

    const testEvent = {
      id: 'event-123',
      calendarIds: ['primary'],
      summary: 'Test Meeting',
      startTime: new Date('2026-09-17T10:00:00Z'),
      endTime: new Date('2026-09-17T11:00:00Z'),
      isAllDay: false,
      myResponseStatus: 1,
      webUrl: 'https://www.google.com/calendar/event?eid=ABC123xyz',
    };

    // Populate cachedEvents
    (service as any).cachedEvents.set('acc1', [testEvent]);

    const result = await service.deleteEvent('acc1', 'event-123');
    expect(result).toBe(true);
    expect(performDelete).toHaveBeenCalledWith('acc1', 'ABC123xyz', testEvent.startTime, false);
    expect((service as any).cachedEvents.get('acc1')).toEqual([]);
  });

  it('shows the day, not the edit form, when a background delete fails', async () => {
    const performDelete = vi.fn().mockResolvedValue('failed' as const);
    let navigatedUrl = '';
    const service = new CalendarService(
      () => [{ id: 'acc1', name: 'Personal', color: '#000', email: 'test@example.com' }],
      (_acc, url) => {
        navigatedUrl = url;
      },
      async () => 'ok' as const,
      undefined,
      undefined,
      performDelete,
    );

    const testEvent = {
      id: 'event-123',
      calendarIds: ['primary'],
      summary: 'Test Meeting',
      startTime: new Date('2026-09-17T10:00:00Z'),
      endTime: new Date('2026-09-17T11:00:00Z'),
      isAllDay: false,
      myResponseStatus: 1,
      webUrl: 'https://www.google.com/calendar/event?eid=ABC123xyz',
    };

    (service as any).cachedEvents.set('acc1', [testEvent]);

    const result = await service.deleteEvent('acc1', 'event-123');
    expect(result).toBe(false);
    expect(performDelete).toHaveBeenCalled();
    // Landing someone in an editor because a delete did not go through is worse than
    // the delete not going through.
    expect(navigatedUrl).not.toContain('eventedit');
    expect(navigatedUrl).toContain('/r/day/');
  });

  it('tells the view a task is a task, so it withholds the editor fallback', async () => {
    const performDelete = vi.fn().mockResolvedValue('ok' as const);
    const service = new CalendarService(
      () => [{ id: 'acc1', name: 'Personal', color: '#000', email: 'test@example.com' }],
      () => {},
      async () => 'ok' as const,
      undefined,
      undefined,
      performDelete,
    );

    const task = {
      id: 'task-1',
      calendarIds: ['tasks@tasks.google.com'],
      summary: 'Book the venue',
      startTime: new Date('2026-09-17T10:00:00Z'),
      endTime: new Date('2026-09-17T11:00:00Z'),
      isAllDay: false,
      eventType: EVENT_TYPE.TASK,
      myResponseStatus: 'notInvited',
      webUrl: 'https://www.google.com/calendar/event?eid=TASKEID',
    };
    (service as any).cachedEvents.set('acc1', [task]);

    await service.deleteEvent('acc1', 'task-1');

    expect(performDelete).toHaveBeenCalledWith('acc1', 'TASKEID', task.startTime, true);
  });

  it('tells the view a focus time block is an ordinary event, not a task', async () => {
    const performDelete = vi.fn().mockResolvedValue('ok' as const);
    const service = new CalendarService(
      () => [{ id: 'acc1', name: 'Personal', color: '#000', email: 'test@example.com' }],
      () => {},
      async () => 'ok' as const,
      undefined,
      undefined,
      performDelete,
    );

    const focusTime = {
      id: 'focus-1',
      calendarIds: ['me@work.com'],
      summary: 'Focus time',
      startTime: new Date('2026-09-17T10:00:00Z'),
      endTime: new Date('2026-09-17T11:00:00Z'),
      isAllDay: false,
      eventType: EVENT_TYPE.FOCUS_TIME,
      myResponseStatus: 'notInvited',
      webUrl: 'https://www.google.com/calendar/event?eid=FOCUSEID',
    };
    (
      service as unknown as { cachedEvents: Map<string, NormalizedCalendarEvent[]> }
    ).cachedEvents.set('acc1', [focusTime as NormalizedCalendarEvent]);

    await service.deleteEvent('acc1', 'focus-1');

    expect(performDelete).toHaveBeenCalledWith('acc1', 'FOCUSEID', focusTime.startTime, false);
  });
});

describe('setTaskCompleted', () => {
  const task = {
    id: 'task-1',
    calendarIds: ['tasks@tasks.google.com'],
    summary: 'Book the venue',
    startTime: new Date('2026-09-17T10:00:00Z'),
    endTime: new Date('2026-09-17T11:00:00Z'),
    isAllDay: false,
    eventType: EVENT_TYPE.TASK,
    myResponseStatus: 'notInvited',
    webUrl: 'https://www.google.com/calendar/event?eid=TASKEID',
  };

  function serviceWith(outcome: 'ok' | 'busy' | 'failed') {
    const performComplete = vi.fn().mockResolvedValue(outcome);
    let navigatedUrl = '';
    const service = new CalendarService(
      () => [{ id: 'acc1', name: 'Personal', color: '#000', email: 'test@example.com' }],
      (_acc, url) => {
        navigatedUrl = url;
      },
      async () => 'ok' as const,
      undefined,
      undefined,
      undefined,
      performComplete,
    );
    (service as any).cachedEvents.set('acc1', [task]);
    return { service, performComplete, navigatedUrl: () => navigatedUrl };
  }

  it('drives the view with the task\u2019s own eid', async () => {
    const { service, performComplete } = serviceWith('ok');

    expect(await service.setTaskCompleted('acc1', 'task-1', true)).toBe(true);
    expect(performComplete).toHaveBeenCalledWith('acc1', 'TASKEID', task.startTime, true);
  });

  it('marks the task completed in the cache', async () => {
    const { service } = serviceWith('ok');

    await service.setTaskCompleted('acc1', 'task-1', true);

    const cached = (service as any).cachedEvents.get('acc1');
    expect(cached).toHaveLength(1);
    expect(cached[0].isCompleted).toBe(true);
    expect(cached[0].completedAt).toBeInstanceOf(Date);
  });

  it('marks the task open again in the cache', async () => {
    const { service, performComplete } = serviceWith('ok');

    await service.setTaskCompleted('acc1', 'task-1', false);

    expect(performComplete).toHaveBeenCalledWith('acc1', 'TASKEID', task.startTime, false);
    const cached = (service as any).cachedEvents.get('acc1');
    expect(cached[0].isCompleted).toBe(false);
    expect(cached[0].completedAt).toBeNull();
  });

  it('opens the task when completing it in the background fails', async () => {
    const { service, navigatedUrl } = serviceWith('failed');

    expect(await service.setTaskCompleted('acc1', 'task-1', true)).toBe(false);
    expect(navigatedUrl()).toContain('/r/day/');
  });
});

describe('RSVP-pending dock badge', () => {
  const invite = (id: string): NormalizedCalendarEvent => ({
    id,
    calendarIds: ['me@work.com'],
    summary: 'Design review',
    webUrl: 'https://www.google.com/calendar/event?eid=ABC',
    created: null,
    updated: null,
    startTime: inHours(24),
    endTime: inHours(25),
    isAllDay: false,
    myResponseStatus: 0,
    attendees: [],
    reminders: 'unknown',
  });

  beforeEach(() => {
    updateDockBadge.mockClear();
    updateToolbarInvites.mockClear();
    pollerEvents.clear();
  });

  it('stops counting invitations for an account that has been removed', async () => {
    const accounts = [
      { id: 'a', name: 'Work', partition: 'pa', color: '#000' },
      { id: 'b', name: 'Personal', partition: 'pb', color: '#111' },
    ];
    pollerEvents.set('google:a', [invite('a1'), invite('a2')]);
    pollerEvents.set('google:b', [invite('b1')]);

    const service = new CalendarService(
      () => accounts,
      () => {},
      async () => 'ok' as const,
    );
    service.syncPollers();
    service.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenCalledWith(3));

    // Signing the account out leaves nothing that could ever answer its invitations, so
    // the badge has to drop them rather than show a number the user cannot work off.
    accounts.splice(0, 1);
    service.syncPollers();
    expect(updateDockBadge).toHaveBeenLastCalledWith(1);

    service.stop();
  });
});

describe('forgetting a removed account', () => {
  const account = { id: 'a', name: 'Work', partition: 'pa', color: '#000' };
  const other = { id: 'b', name: 'Personal', partition: 'pb', color: '#111' };

  /** An event as `event-cache.json` holds it: dates are epoch milliseconds on disk. */
  const persisted = (id: string, startTime: Date) => ({
    id,
    calendarIds: ['me@work.com'],
    summary: 'Design review',
    webUrl: '',
    created: null,
    updated: null,
    startTime: startTime.getTime(),
    endTime: startTime.getTime() + 3_600_000,
    isAllDay: false,
    myResponseStatus: 0,
    attendees: [],
    reminders: 'unknown',
  });

  it('purges the account from the sealed event cache and the alert record', () => {
    const start = inHours(24);
    const eventsFile = path.join(stateDir, 'event-cache.json');
    const alertsFile = path.join(stateDir, 'alert-state.json');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      eventsFile,
      JSON.stringify({
        events: { a: [persisted('a1', start)], b: [persisted('b1', start)] },
      }),
    );
    fs.writeFileSync(
      alertsFile,
      JSON.stringify({
        notified: ['google:a|invite|a1', 'google:b|invite|b1'],
        activeArrivals: ['google:a|invite|a1'],
      }),
    );

    const service = new CalendarService(
      () => [account, other],
      () => {},
      async () => 'ok' as const,
    );
    expect(service.getCachedEvents().get('a')).toHaveLength(1);

    service.forgetAccount('a');

    expect(service.getCachedEvents().has('a')).toBe(false);
    expect(service.getCachedEvents().get('b')).toHaveLength(1);

    const alerts = readSecretFile<{ notified: string[]; activeArrivals: string[] }>(alertsFile);
    expect(alerts?.notified).toEqual(['google:b|invite|b1']);
    // An arrival left for a gone account is a mark on the badge the user cannot clear.
    expect(alerts?.activeArrivals).toEqual([]);
    const events = readSecretFile<{ events: Record<string, unknown[]> }>(eventsFile);
    expect(Object.keys(events?.events ?? {})).toEqual(['b']);

    service.stop();
  });
});

describe('the invitations dropdown', () => {
  const account = { id: 'a', name: 'Work', partition: 'pa', color: '#000' };
  const other = { id: 'b', name: 'Personal', partition: 'pb', color: '#111' };

  const invite = (overrides: Partial<NormalizedCalendarEvent> = {}): NormalizedCalendarEvent => ({
    id: 'evt',
    calendarIds: ['me@work.com'],
    summary: 'Design review',
    webUrl: 'https://www.google.com/calendar/event?eid=ABC',
    created: null,
    updated: null,
    startTime: inHours(24),
    endTime: inHours(25),
    isAllDay: false,
    myResponseStatus: 0,
    attendees: [],
    reminders: 'unknown',
    ...overrides,
  });

  async function serviceWithInvites(accounts: (typeof account)[], activeId = accounts[0].id) {
    const performRsvp = vi.fn(async (): Promise<'ok' | 'busy' | 'failed'> => 'ok');
    const reveal = vi.fn(async () => 'revealed' as const);
    for (const a of accounts) pollerEvents.set(`google:${a.id}`, [invite({ id: `${a.id}-evt` })]);

    const service = new CalendarService(
      () => accounts,
      () => {},
      performRsvp,
      reveal,
    );
    service.setActiveAccount(activeId);
    service.syncPollers();
    service.pollNow();
    // Waiting on the count the poll produces, not merely on a first call: setting the
    // active account publishes an empty badge before any poll has run.
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenLastCalledWith(accounts.length));
    return { service, performRsvp, reveal };
  }

  function listed() {
    return (updateToolbarInvites.mock.lastCall?.[0] ?? []) as {
      key: string;
      summary: string;
      detail: string;
    }[];
  }

  beforeEach(() => {
    updateDockBadge.mockClear();
    updateToolbarInvites.mockClear();
    pollerEvents.clear();
  });

  it('lists what is outstanding on the active account', async () => {
    const { service } = await serviceWithInvites([account]);

    expect(listed()).toHaveLength(1);
    expect(listed()[0].summary).toBe('Design review');
    expect(updateDockBadge).toHaveBeenLastCalledWith(1);

    service.stop();
  });

  it('keeps another account out of the dropdown, but not out of the badge', async () => {
    const { service } = await serviceWithInvites([account, other]);

    // Both accounts have one outstanding. Only the active one is answerable in the
    // calendar behind the dropdown.
    expect(listed()).toHaveLength(1);
    expect(listed()[0].key).toContain('google:a');
    // The Dock badge belongs to the app, so it still counts both.
    expect(updateDockBadge).toHaveBeenLastCalledWith(2);

    service.stop();
  });

  it('follows the active account when it changes', async () => {
    const { service } = await serviceWithInvites([account, other]);
    expect(listed()[0].key).toContain('google:a');

    service.setActiveAccount('b');
    expect(listed()).toHaveLength(1);
    expect(listed()[0].key).toContain('google:b');
    expect(updateDockBadge).toHaveBeenLastCalledWith(2);

    service.stop();
  });

  it('answers in place rather than opening the event', async () => {
    const { service, performRsvp } = await serviceWithInvites([account]);
    const key = listed()[0].key;

    service.handleInviteAction('invite:yes', key);
    await vi.waitFor(() => expect(performRsvp).toHaveBeenCalled());
    expect(performRsvp.mock.lastCall?.[2]).toBe('yes');

    // Answering clears it from both the badge and the list, without another poll.
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenLastCalledWith(0));
    expect(listed()).toEqual([]);

    service.stop();
  });

  it('opens the event when asked to, without answering it', async () => {
    const { service, performRsvp, reveal } = await serviceWithInvites([account]);
    const key = listed()[0].key;

    service.handleInviteAction('invite:open', key);
    await vi.waitFor(() => expect(reveal).toHaveBeenCalled());
    expect(performRsvp).not.toHaveBeenCalled();

    service.stop();
  });

  // The popover names the event, not the invitation, and answering from it used to go
  // straight to `performRsvp`. These pin the three things that route skipped.
  describe('answered from the menu bar popover', () => {
    it('drops the invitation as the answer lands, rather than at the next poll', async () => {
      const { service, performRsvp } = await serviceWithInvites([account]);

      await service.answerRsvp('a', 'a-evt', 'yes');

      // The chip is addressed by the eid out of the event's web URL. The popover sends an
      // event id, which names nothing Google can click.
      expect(performRsvp.mock.lastCall?.[1]).toBe('ABC');
      expect(performRsvp.mock.lastCall?.[2]).toBe('yes');
      // The poller still reports it as unanswered, so the badge cannot have dropped
      // because a fresh read said so.
      expect(pollerEvents.get('google:a')?.[0].myResponseStatus).toBe(0);
      expect(updateDockBadge).toHaveBeenLastCalledWith(0);
      expect(listed()).toEqual([]);

      service.stop();
    });

    it('holds an answer pressed while an editor is open, and lands it afterwards', async () => {
      const { service, performRsvp, reveal } = await serviceWithInvites([account]);
      performRsvp.mockResolvedValue('busy');

      vi.useFakeTimers();
      try {
        await service.answerRsvp('a', 'a-evt', 'no');

        // Held, not dropped and not silently turned into opening the event.
        expect(updateDockBadge).toHaveBeenLastCalledWith(1);
        expect(listed()).toHaveLength(1);
        expect(reveal).not.toHaveBeenCalled();

        performRsvp.mockResolvedValue('ok');
        await vi.advanceTimersByTimeAsync(5_000);

        expect(performRsvp).toHaveBeenCalledTimes(2);
        expect(updateDockBadge).toHaveBeenLastCalledWith(0);
        expect(listed()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }

      service.stop();
    });

    it('opens the event when driving Google fails, rather than losing the answer', async () => {
      const { service, performRsvp, reveal } = await serviceWithInvites([account]);
      performRsvp.mockResolvedValue('failed');

      await service.answerRsvp('a', 'a-evt', 'maybe');

      await vi.waitFor(() => expect(reveal).toHaveBeenCalled());
      expect(reveal.mock.lastCall?.[1]).toBe('ABC');
      // Nothing landed, so the invitation is still waiting on an answer.
      expect(updateDockBadge).toHaveBeenLastCalledWith(1);
      expect(listed()).toHaveLength(1);

      service.stop();
    });

    it('answers an invitation the watcher never saw, and has nothing to drop', async () => {
      const { service, performRsvp } = await serviceWithInvites([account]);
      // An event in the cache that no poll ever reported as pending — one outside the
      // window the watcher was seeded from.
      const cached = service.getCachedEvents().get('a') ?? [];
      cached.push(
        invite({
          id: 'a-unseen',
          summary: 'Budget review',
          webUrl: 'https://www.google.com/calendar/event?eid=XYZ',
        }),
      );

      await service.answerRsvp('a', 'a-unseen', 'yes');

      expect(performRsvp.mock.lastCall?.[1]).toBe('XYZ');
      // The tracked invitation is untouched; only the one that was answered would have
      // gone, and it was never counted.
      expect(updateDockBadge).toHaveBeenLastCalledWith(1);
      expect(listed()).toHaveLength(1);

      service.stop();
    });
  });
});

describe('truncateTitle', () => {
  it('leaves an ordinary meeting title alone', () => {
    expect(truncateTitle('Design review')).toBe('Design review');
    expect(truncateTitle('Incident Review Meeting')).toBe('Incident Review Meeting');
  });

  it('cuts a title long enough to stretch the whole menu', () => {
    // An NSMenu is as wide as its widest item, and one of these across the window was
    // what made the dropdown unusable.
    const long = 'Quarterly Product Strategy and Roadmap Planning Meeting';
    const cut = truncateTitle(long);
    expect(cut.length).toBeLessThanOrEqual(41);
    expect(cut.endsWith('\u2026')).toBe(true);
    expect(long.startsWith(cut.slice(0, -1).trimEnd())).toBe(true);
  });

  it('cuts at a word boundary rather than mid-word', () => {
    expect(truncateTitle('Marketing office hours with the whole department team', 30)).toBe(
      'Marketing office hours with\u2026',
    );
  });

  it('cuts hard when there is no word boundary near the end', () => {
    const unbroken = 'A'.repeat(60);
    expect(truncateTitle(unbroken, 20)).toBe(`${'A'.repeat(20)}\u2026`);
  });
});

describe('formatInviteWhen', () => {
  const baseEvent: NormalizedCalendarEvent = {
    id: 'evt-1',
    calendarIds: ['primary'],
    summary: 'Meeting',
    created: null,
    updated: null,
    // A timed event is an instant read on the machine's clock, so it is built from local
    // fields: the line then names 11 August in every zone, rather than the UTC day, which is
    // the 12th east of UTC.
    startTime: new Date(2026, 7, 11, 14, 30, 0),
    endTime: new Date(2026, 7, 11, 15, 0, 0),
    isAllDay: false,
    eventType: EVENT_TYPE.DEFAULT,
    myResponseStatus: RESPONSE_NEEDS_ACTION,
  };

  it('omits the year when an invite falls within the current year', () => {
    // Built from local fields so `now` is on the reader's calendar in 2026 in every zone: a
    // UTC instant on 1 January is still the year before for anyone west of UTC.
    const now = new Date(2026, 0, 1, 12, 0, 0);
    const formatted = formatInviteWhen(baseEvent, now);
    expect(formatted).not.toContain('2026');
    expect(formatted).toMatch(/Aug/);
    expect(formatted).toMatch(/11/);
  });

  it('includes the year when an invite falls in a different year', () => {
    // Local fields again, so `now` is the previous year on the reader's calendar in every
    // zone: a UTC instant on 31 December is already the next year east of UTC.
    const now = new Date(2025, 11, 31, 12, 0, 0);
    const formatted = formatInviteWhen(baseEvent, now);
    expect(formatted).toContain('2026');
    expect(formatted).toMatch(/Aug/);
    expect(formatted).toMatch(/11/);
  });

  it('formats all-day invites without the year when in the current year', () => {
    const allDayEvent: NormalizedCalendarEvent = {
      ...baseEvent,
      startTime: new Date('2026-08-11T00:00:00Z'),
      endTime: new Date('2026-08-12T00:00:00Z'),
      isAllDay: true,
    };
    const now = new Date('2026-05-01T00:00:00Z');
    const formatted = formatInviteWhen(allDayEvent, now);
    expect(formatted).not.toContain('2026');
    expect(formatted).toMatch(/Aug/);
    expect(formatted).toMatch(/11/);
  });

  it('formats all-day invites with the year when in a future or past year', () => {
    const allDayEvent: NormalizedCalendarEvent = {
      ...baseEvent,
      startTime: new Date('2027-08-11T00:00:00Z'),
      endTime: new Date('2027-08-12T00:00:00Z'),
      isAllDay: true,
    };
    const now = new Date('2026-05-01T00:00:00Z');
    const formatted = formatInviteWhen(allDayEvent, now);
    expect(formatted).toContain('2027');
    expect(formatted).toMatch(/Aug/);
    expect(formatted).toMatch(/11/);
  });
});

describe('what the Dock badge counts', () => {
  const account = { id: 'a', name: 'Work', partition: 'pa', color: '#000' };

  const invite = (id: string): NormalizedCalendarEvent => ({
    id,
    calendarIds: ['me@work.com'],
    summary: 'Design review',
    webUrl: 'https://www.google.com/calendar/event?eid=ABC',
    created: null,
    updated: null,
    startTime: inHours(24),
    endTime: inHours(25),
    isAllDay: false,
    myResponseStatus: 0,
    attendees: [],
    reminders: 'unknown',
  });

  /** Two invitations already in the window when Magical first looks, so both are backlog. */
  async function serviceWithBacklog() {
    pollerEvents.set('google:a', [invite('a1'), invite('a2')]);
    const performRsvp = vi.fn(async () => 'ok' as const);
    const service = new CalendarService(
      () => [account],
      () => {},
      performRsvp,
    );
    service.setActiveAccount('a');
    service.syncPollers();
    service.pollNow();
    await vi.waitFor(() => expect(updateToolbarInvites.mock.lastCall?.[0]).toHaveLength(2));
    return { service, performRsvp };
  }

  beforeEach(() => {
    updateDockBadge.mockClear();
    updateToolbarInvites.mockClear();
    pollerEvents.clear();
    dockBadgeMode.mockReturnValue('allPending');
  });

  it('counts the whole pile on the default setting', async () => {
    const { service } = await serviceWithBacklog();
    expect(updateDockBadge).toHaveBeenLastCalledWith(2);
    service.stop();
  });

  it('leaves the backlog out of the new-invitations count', async () => {
    dockBadgeMode.mockReturnValue('newInvitations');
    const { service } = await serviceWithBacklog();

    // Nothing arrived; these were already there when Magical first looked. A badge that
    // counted them would show a number that never moves.
    expect(updateDockBadge).toHaveBeenLastCalledWith(0);
    // The dropdown still lists the whole pile.
    expect(updateToolbarInvites.mock.lastCall?.[0]).toHaveLength(2);

    service.stop();
  });

  it('counts an invitation that arrives afterwards', async () => {
    dockBadgeMode.mockReturnValue('newInvitations');
    const { service } = await serviceWithBacklog();

    pollerEvents.set('google:a', [invite('a1'), invite('a2'), invite('a3')]);
    service.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenLastCalledWith(1));

    service.stop();
  });

  it('comes down only when the invitation is answered', async () => {
    dockBadgeMode.mockReturnValue('newInvitations');
    const { service } = await serviceWithBacklog();
    pollerEvents.set('google:a', [invite('a1'), invite('a2'), invite('a3')]);
    service.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenLastCalledWith(1));

    const key = (updateToolbarInvites.mock.lastCall?.[0] as { key: string }[]).find((i) =>
      i.key.endsWith('a3'),
    )!.key;
    service.handleInviteAction('invite:yes', key);
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenLastCalledWith(0));

    service.stop();
  });

  it('clears when the whole list is marked read, leaving the pile listed', async () => {
    dockBadgeMode.mockReturnValue('newInvitations');
    const { service } = await serviceWithBacklog();
    pollerEvents.set('google:a', [invite('a1'), invite('a2'), invite('a3')]);
    service.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenLastCalledWith(1));

    service.handleInvitesReadAll();
    expect(updateDockBadge).toHaveBeenLastCalledWith(0);
    expect(updateToolbarInvites.mock.lastCall?.[0]).toHaveLength(3);

    service.stop();
  });

  it('clears one invitation marked read, leaving it in the list', async () => {
    dockBadgeMode.mockReturnValue('newInvitations');
    const { service } = await serviceWithBacklog();
    pollerEvents.set('google:a', [invite('a1'), invite('a2'), invite('a3')]);
    service.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenLastCalledWith(1));

    const rows = updateToolbarInvites.mock.lastCall?.[0] as { key: string; isNew: boolean }[];
    service.handleInviteAction('invite:read', rows.find((r) => r.key.endsWith('a3'))!.key);

    expect(updateDockBadge).toHaveBeenLastCalledWith(0);
    expect(updateToolbarInvites).toHaveBeenLastCalledWith(expect.any(Array), 0);
    expect(updateToolbarInvites.mock.lastCall?.[0]).toHaveLength(3);

    service.stop();
  });

  it('marks the rows the badge counts, so the two cannot disagree', async () => {
    dockBadgeMode.mockReturnValue('newInvitations');
    const { service } = await serviceWithBacklog();
    pollerEvents.set('google:a', [invite('a1'), invite('a2'), invite('a3')]);
    service.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenLastCalledWith(1));

    const rows = updateToolbarInvites.mock.lastCall?.[0] as { key: string; isNew: boolean }[];
    expect(rows.filter((r) => r.isNew)).toHaveLength(1);
    expect(rows.find((r) => r.isNew)?.key).toContain('a3');

    service.stop();
  });

  it('reports arrivals per account, for the switcher dots', async () => {
    const { service } = await serviceWithBacklog();
    expect(service.newArrivalsByAccount().get('a') ?? 0).toBe(0);

    pollerEvents.set('google:a', [invite('a1'), invite('a2'), invite('a3')]);
    service.pollNow();
    await vi.waitFor(() => expect(service.newArrivalsByAccount().get('a')).toBe(1));

    // Keyed by account id, not by the poller's source id.
    expect([...service.newArrivalsByAccount().keys()]).toEqual(['a']);

    service.stop();
  });

  it('tells the switcher whenever the arrivals move', async () => {
    const onInvitesChanged = vi.fn();
    const { service } = await serviceWithBacklog();
    service.onInvitesChanged = onInvitesChanged;

    pollerEvents.set('google:a', [invite('a1'), invite('a2'), invite('a3')]);
    service.pollNow();
    await vi.waitFor(() => expect(onInvitesChanged).toHaveBeenCalled());

    service.stop();
  });

  it('redraws the badge when the setting changes, without re-polling', async () => {
    dockBadgeMode.mockReturnValue('newInvitations');
    const { service } = await serviceWithBacklog();
    expect(updateDockBadge).toHaveBeenLastCalledWith(0);

    dockBadgeMode.mockReturnValue('allPending');
    service.applyBadgeSetting();
    expect(updateDockBadge).toHaveBeenLastCalledWith(2);

    service.stop();
  });
});

describe('what each account owes a reply on', () => {
  const accounts = [
    { id: 'a', name: 'Work', partition: 'pa', color: '#000' },
    { id: 'b', name: 'Personal', partition: 'pb', color: '#111' },
  ];

  const invite = (id: string): NormalizedCalendarEvent => ({
    id,
    calendarIds: ['me@work.com'],
    summary: 'Design review',
    webUrl: 'https://www.google.com/calendar/event?eid=ABC',
    created: null,
    updated: null,
    startTime: inHours(24),
    endTime: inHours(25),
    isAllDay: false,
    myResponseStatus: 0,
    attendees: [],
    reminders: 'unknown',
  });

  async function polled() {
    const service = new CalendarService(
      () => accounts,
      () => {},
      async () => 'ok' as const,
    );
    service.setActiveAccount('a');
    service.syncPollers();
    service.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenCalledWith(3));
    return service;
  }

  beforeEach(() => {
    updateDockBadge.mockClear();
    updateToolbarInvites.mockClear();
    pollerEvents.clear();
    pollerEvents.set('google:a', [invite('a1'), invite('a2')]);
    pollerEvents.set('google:b', [invite('b1')]);
  });

  it('counts them per account, under the account id rather than the source id', async () => {
    const service = await polled();

    expect(service.pendingByAccount().get('a')).toBe(2);
    expect(service.pendingByAccount().get('b')).toBe(1);
    // `google:a` is what the poller is called; the tray and the switcher both key on `a`.
    expect([...service.pendingByAccount().keys()].sort()).toEqual(['a', 'b']);

    service.stop();
  });

  it('loses one the moment it is answered, not at the next poll', async () => {
    const service = await polled();
    const key = (updateToolbarInvites.mock.lastCall?.[0] as { key: string }[])[0].key;

    service.handleInviteAction('invite:yes', key);
    await vi.waitFor(() => expect(service.pendingByAccount().get('a')).toBe(1));

    // This is why the count comes from here rather than from the events the tray was
    // pushed: the cache still holds both, and still says `needsAction` on both, until a
    // poll returns.
    expect(service.getCachedEvents().get('a')).toHaveLength(2);

    service.stop();
  });

  it('forgets an account that has been signed out', async () => {
    const service = await polled();

    accounts.splice(1, 1);
    service.syncPollers();

    expect(service.pendingByAccount().has('b')).toBe(false);
    accounts.push({ id: 'b', name: 'Personal', partition: 'pb', color: '#111' });

    service.stop();
  });
});

describe('the polled window', () => {
  const account = { id: 'a', name: 'Work', partition: 'pa', color: '#000' };

  /** Enough microtask turns for a poll to finish; nothing on that path waits on a timer. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  const DAY_MS = 86_400_000;

  /** Whole days between two instants, ignoring the hour a DST boundary moves. */
  const daysBetween = (from: Date, to: Date) =>
    Math.round((to.getTime() - from.getTime()) / 86_400_000);

  const event = (id: string, startTime: Date): NormalizedCalendarEvent => ({
    id,
    calendarIds: ['me@work.com'],
    summary: 'Retro',
    webUrl: 'https://www.google.com/calendar/event?eid=ABC',
    created: null,
    updated: null,
    startTime,
    endTime: new Date(startTime.getTime() + 3_600_000),
    isAllDay: false,
    myResponseStatus: 1,
    attendees: [],
    reminders: 'unknown',
  });

  function service() {
    const created = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    created.syncPollers();
    return created;
  }

  beforeEach(() => {
    pollerEvents.clear();
    polledRanges.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-10T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rolls forward with the calendar day rather than sitting where it launched', async () => {
    const magical = service();
    magical.pollNow();
    await flush();

    // Forty days of a Mac left running, which is what a menu bar app normally does.
    vi.setSystemTime(new Date('2026-02-19T12:00:00Z'));
    magical.pollNow();
    await flush();
    magical.stop();

    expect(polledRanges).toHaveLength(2);
    const [first, second] = polledRanges;
    expect(daysBetween(first.start, second.start)).toBe(40);
    expect(daysBetween(first.end, second.end)).toBe(40);
  });

  it('fetches the month the user paged to, and keeps it in the cache', async () => {
    const magical = service();
    magical.pollNow();
    await flush();

    // Only the paged-to fetch returns this event; the baseline poll never sees it.
    pollerEvents.set('google:a', [event('june', new Date('2027-06-15T09:00:00Z'))]);
    const start = new Date('2027-06-01T00:00:00Z');
    const end = new Date('2027-06-30T23:59:59Z');
    await magical.ensureRange(start, end);

    expect(polledRanges[1].start.getTime()).toBeLessThanOrEqual(start.getTime());
    expect(polledRanges[1].end.getTime()).toBeGreaterThanOrEqual(end.getTime());
    expect(
      magical
        .getCachedEvents()
        .get('a')
        ?.map((e) => e.id),
    ).toEqual(['june']);

    pollerEvents.set('google:a', []);
    magical.pollNow();
    await flush();
    magical.stop();

    // The poll reads the baseline alone, so it has nothing to say about June 2027 and
    // must not evict it.
    expect(
      magical
        .getCachedEvents()
        .get('a')
        ?.map((e) => e.id),
    ).toEqual(['june']);
  });

  it('answers a second page to the same month from the cache, reading nothing', async () => {
    const magical = service();
    magical.pollNow();
    await flush();

    const start = new Date('2027-06-01T00:00:00Z');
    const end = new Date('2027-06-30T23:59:59Z');
    await magical.ensureRange(start, end);
    const afterFirstPage = polledRanges.length;

    await magical.ensureRange(start, end);
    magical.stop();

    // June is in the ledger now, so the month is answered from the cache and no source is
    // asked for it a second time.
    expect(polledRanges).toHaveLength(afterFirstPage);
  });

  it('reads a paged month again once its ledger entry has aged', async () => {
    const magical = service();
    magical.pollNow();
    await flush();

    const start = new Date('2027-06-01T00:00:00Z');
    const end = new Date('2027-06-30T23:59:59Z');
    await magical.ensureRange(start, end);
    const afterFirstPage = polledRanges.length;

    // Past the ledger's life: the month is re-read rather than served from a copy that may
    // name a meeting cancelled since the first read.
    const realNow = Date.now.bind(Date);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * 60 * 1000);
    await magical.ensureRange(start, end);
    nowSpy.mockRestore();
    magical.stop();

    expect(polledRanges.length).toBeGreaterThan(afterFirstPage);
  });

  it('reads only the days a request does not already hold', async () => {
    const magical = service();
    magical.pollNow();
    await flush();

    const julyStart = new Date('2027-07-01T00:00:00Z');
    const julyEnd = new Date('2027-07-31T23:59:59Z');
    await magical.ensureRange(julyStart, julyEnd);
    const afterJuly = polledRanges.length;

    // A back-tap from July to June. July is loaded, so the gap is June alone rather than
    // the whole two months a shared range would ask for.
    const juneStart = new Date('2027-06-01T00:00:00Z');
    await magical.ensureRange(juneStart, julyEnd);
    magical.stop();

    expect(polledRanges).toHaveLength(afterJuly + 1);
    const gap = polledRanges[afterJuly];
    expect(gap.start.getTime()).toBe(juneStart.getTime());
    expect(gap.end.getTime()).toBeLessThan(julyStart.getTime());
  });

  it('leaves the recurring poll at the baseline after the user pages away', async () => {
    const magical = service();
    magical.pollNow();
    await flush();
    const baseline = polledRanges[0];

    await magical.ensureRange(new Date('2019-01-01T00:00:00Z'), new Date('2019-01-31T00:00:00Z'));
    await magical.ensureRange(new Date('2027-06-01T00:00:00Z'), new Date('2027-06-30T00:00:00Z'));

    magical.pollNow();
    await flush();
    magical.stop();

    const last = polledRanges[polledRanges.length - 1];
    expect(last.start.getTime()).toBe(baseline.start.getTime());
    expect(last.end.getTime()).toBe(baseline.end.getTime());
  });

  it('keeps a cached event the window has rolled past, so paging back to it is free', async () => {
    pollerEvents.set('google:a', [event('old', new Date('2025-10-20T09:00:00Z'))]);

    const magical = service();
    magical.pollNow();
    await flush();
    expect(magical.getCachedEvents().get('a')).toHaveLength(1);

    // Forty days on it sits before the window start, so the poll no longer returns it.
    pollerEvents.set('google:a', []);
    vi.setSystemTime(new Date('2026-02-19T12:00:00Z'));
    magical.pollNow();
    await flush();
    magical.stop();

    expect(
      magical
        .getCachedEvents()
        .get('a')
        ?.map((e) => e.id),
    ).toEqual(['old']);
  });

  it('drops a rolled-past event once the day it was read on ages out', async () => {
    pollerEvents.set('google:a', [event('old', new Date('2025-10-20T09:00:00Z'))]);

    const magical = service();
    magical.pollNow();
    await flush();
    expect(magical.getCachedEvents().get('a')).toHaveLength(1);

    // The retention clock runs from the last fetch that covered the day, not
    // from the event: ninety-one days on, no poll has re-read it, so it goes.
    pollerEvents.set('google:a', []);
    vi.setSystemTime(new Date('2026-04-11T12:00:00Z'));
    magical.pollNow();
    await flush();
    magical.stop();

    expect(magical.getCachedEvents().get('a')).toHaveLength(0);
  });

  it('drops an event the poll no longer returns from inside the range it read', async () => {
    pollerEvents.set('google:a', [event('cancelled', new Date('2026-01-20T09:00:00Z'))]);

    const magical = service();
    magical.pollNow();
    await flush();
    expect(magical.getCachedEvents().get('a')).toHaveLength(1);

    pollerEvents.set('google:a', []);
    magical.pollNow();
    await flush();
    magical.stop();

    expect(magical.getCachedEvents().get('a')).toHaveLength(0);
  });

  it('reads nothing for a range the baseline window already covers', async () => {
    const magical = service();
    magical.pollNow();
    await flush();
    const baseline = polledRanges[0];

    await magical.ensureRange(
      new Date(baseline.start.getTime() + DAY_MS),
      new Date(baseline.end.getTime() - DAY_MS),
    );
    magical.stop();

    expect(polledRanges).toHaveLength(1);
  });

  it('does not re-poll in refreshIfStale within the cooldown window', async () => {
    const magical = service();
    magical.pollNow();
    await flush();
    expect(polledRanges).toHaveLength(1);

    // Opening the popover within 60s should not trigger another full poll
    vi.advanceTimersByTime(10_000);
    magical.refreshIfStale();
    await flush();
    expect(polledRanges).toHaveLength(1);

    // After 60s (FOCUS_POLL_MIN_GAP_MS), refreshIfStale polls again
    vi.advanceTimersByTime(55_000);
    magical.refreshIfStale();
    await flush();
    expect(polledRanges).toHaveLength(2);
    magical.stop();
  });

  it('reads only the days beyond the edge when a request overlaps the baseline', async () => {
    const magical = service();
    magical.pollNow();
    await flush();
    const baseline = polledRanges[0];

    // A back-tap on the mini-month: 60 days either side of a target 30 days past the edge.
    const requestedStart = new Date(baseline.start.getTime() - 30 * DAY_MS);
    await magical.ensureRange(requestedStart, new Date(baseline.start.getTime() + 90 * DAY_MS));
    magical.stop();

    expect(polledRanges).toHaveLength(2);
    expect(polledRanges[1].start.getTime()).toBe(requestedStart.getTime());
    expect(polledRanges[1].end.getTime()).toBe(baseline.start.getTime() - 1);
  });

  it('reads both sides of a request that straddles the baseline, and not the middle', async () => {
    const magical = service();
    magical.pollNow();
    await flush();
    const baseline = polledRanges[0];

    const requestedStart = new Date(baseline.start.getTime() - 10 * DAY_MS);
    const requestedEnd = new Date(baseline.end.getTime() + 10 * DAY_MS);
    await magical.ensureRange(requestedStart, requestedEnd);
    magical.stop();

    expect(polledRanges.slice(1)).toEqual([
      { start: requestedStart, end: new Date(baseline.start.getTime() - 1) },
      { start: new Date(baseline.end.getTime() + 1), end: requestedEnd },
    ]);
  });

  it('fetches the trailing range when a second request arrives while the first is in flight', async () => {
    const magical = service();
    magical.pollNow();
    await flush();

    const marchStart = new Date('2027-03-01T00:00:00Z');
    const marchEnd = new Date('2027-03-31T23:59:59Z');
    const aprilStart = new Date('2027-04-01T00:00:00Z');
    const aprilEnd = new Date('2027-04-30T23:59:59Z');

    pollerEvents.set('google:a', [
      event('ev-march', new Date('2027-03-15T10:00:00Z')),
      event('ev-april', new Date('2027-04-15T10:00:00Z')),
    ]);

    let unblockFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });

    let calls = 0;
    pollerHook = async () => {
      calls++;
      if (calls === 1) {
        await firstBlocked;
      }
    };

    const firstPromise = magical.ensureRange(marchStart, marchEnd);
    const secondPromise = magical.ensureRange(aprilStart, aprilEnd);

    unblockFirst();
    await Promise.all([firstPromise, secondPromise]);
    magical.stop();

    expect(polledRanges).toHaveLength(3);
    expect(polledRanges[1].start.getTime()).toBeLessThanOrEqual(marchStart.getTime());
    expect(polledRanges[1].end.getTime()).toBeGreaterThanOrEqual(marchEnd.getTime());
    expect(polledRanges[2].start.getTime()).toBeLessThanOrEqual(aprilStart.getTime());
    expect(polledRanges[2].end.getTime()).toBeGreaterThanOrEqual(aprilEnd.getTime());

    const eventIds = magical
      .getCachedEvents()
      .get('a')
      ?.map((e) => e.id);
    expect(eventIds).toContain('ev-march');
    expect(eventIds).toContain('ev-april');
  });

  it('discards intermediate requests and fetches the latest pending range when multiple requests arrive in flight', async () => {
    const magical = service();
    magical.pollNow();
    await flush();

    const marchStart = new Date('2027-03-01T00:00:00Z');
    const marchEnd = new Date('2027-03-31T23:59:59Z');
    const aprilStart = new Date('2027-04-01T00:00:00Z');
    const aprilEnd = new Date('2027-04-30T23:59:59Z');
    const mayStart = new Date('2027-05-01T00:00:00Z');
    const mayEnd = new Date('2027-05-31T23:59:59Z');

    let unblockFirst: () => void = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });

    let calls = 0;
    pollerHook = async () => {
      calls++;
      if (calls === 1) {
        await firstBlocked;
      }
    };

    const firstPromise = magical.ensureRange(marchStart, marchEnd);
    const intermediatePromise = magical.ensureRange(aprilStart, aprilEnd);
    const destinationPromise = magical.ensureRange(mayStart, mayEnd);

    unblockFirst();
    await Promise.all([firstPromise, intermediatePromise, destinationPromise]);
    magical.stop();

    expect(polledRanges).toHaveLength(3);
    expect(polledRanges[1].start.getTime()).toBeLessThanOrEqual(marchStart.getTime());
    expect(polledRanges[1].end.getTime()).toBeGreaterThanOrEqual(marchEnd.getTime());
    expect(polledRanges[2].start.getTime()).toBeLessThanOrEqual(mayStart.getTime());
    expect(polledRanges[2].end.getTime()).toBeGreaterThanOrEqual(mayEnd.getTime());
  });
});

describe('calendar alert configuration', () => {
  const account = {
    id: 'a',
    name: 'Work',
    partition: 'pa',
    color: '#000',
    email: 'user@work.com',
    calendarIds: ['user@work.com', 'team@group.calendar.google.com'],
  };

  async function flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  const makeEvent = (
    id: string,
    calendarIds: string[],
    startTime: Date,
    myResponseStatus: number | 'notInvited' = 0,
  ): NormalizedCalendarEvent => ({
    id,
    calendarIds,
    summary: `Meeting ${id}`,
    webUrl: `https://www.google.com/calendar/event?eid=${id}`,
    created: null,
    updated: null,
    startTime,
    endTime: new Date(startTime.getTime() + 3_600_000),
    isAllDay: false,
    myResponseStatus,
    attendees: [],
    reminders: 'unknown',
  });

  it('excludes disabled calendar events from alert scheduling and invite watching', async () => {
    const upcoming = new Date(Date.now() + 10 * 60_000);
    const primaryEvent = makeEvent('evt_primary', ['user@work.com'], upcoming);
    const secondaryEvent = makeEvent('evt_team', ['team@group.calendar.google.com'], upcoming);

    pollerEvents.set('google:a', [primaryEvent, secondaryEvent]);
    disabledAlertCalendarIds.mockReturnValue(['team@group.calendar.google.com']);

    const { AlertScheduler } = await import('../src/alert-scheduler');
    const scheduleSpy = vi.spyOn(AlertScheduler.prototype, 'schedule');

    const magical = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    magical.syncPollers();

    magical.pollNow();
    await flush();

    // Cache should hold both events for agenda/views
    expect(magical.getCachedEvents().get('a')).toHaveLength(2);

    // Alert scheduler should have received only the enabled calendar's event
    expect(scheduleSpy).toHaveBeenCalled();
    const lastScheduleCall = scheduleSpy.mock.calls.at(-1);
    expect(lastScheduleCall?.[0]).toBe('google:a');
    const scheduledEvents = lastScheduleCall?.[1] as NormalizedCalendarEvent[];
    expect(scheduledEvents.map((e) => e.id)).toEqual(['evt_primary']);

    magical.stop();
    scheduleSpy.mockRestore();
  });

  it('still alerts for an event one of whose calendars is not muted', async () => {
    // A meeting the user is in sits on their own calendar as well as on the one that
    // created it. Muting that one must not take the alert off the meeting.
    const upcoming = new Date(Date.now() + 10 * 60_000);
    const shared = makeEvent(
      'evt_shared',
      ['team@group.calendar.google.com', 'user@work.com'],
      upcoming,
    );

    pollerEvents.set('google:a', [shared]);
    disabledAlertCalendarIds.mockReturnValue(['team@group.calendar.google.com']);

    const { AlertScheduler } = await import('../src/alert-scheduler');
    const scheduleSpy = vi.spyOn(AlertScheduler.prototype, 'schedule');

    const magical = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    magical.syncPollers();

    magical.pollNow();
    await flush();

    const scheduled = scheduleSpy.mock.calls.at(-1)?.[1] as NormalizedCalendarEvent[];
    expect(scheduled.map((e) => e.id)).toEqual(['evt_shared']);

    magical.stop();
    scheduleSpy.mockRestore();
  });

  it('mutes a shared calendar id in one account without taking the other’s', async () => {
    // Google gives Birthdays, Tasks and each locale's holidays the same id in every
    // account, so a mute keyed on the id alone silenced the calendar everywhere.
    const upcoming = new Date(Date.now() + 10 * 60_000);
    const holidays = 'en-gb.uk#holiday@group.v.calendar.google.com';
    const work = { ...account, id: 'a', email: 'user@work.com', calendarIds: [holidays] };
    const personal = {
      ...account,
      id: 'b',
      partition: 'pb',
      email: 'user@example.com',
      calendarIds: [holidays],
    };

    pollerEvents.set('google:a', [makeEvent('dst_work', [holidays], upcoming)]);
    pollerEvents.set('google:b', [makeEvent('dst_personal', [holidays], upcoming)]);
    disabledAlertCalendarIds.mockReturnValue([calendarAlertKey('a', holidays)]);

    const { AlertScheduler } = await import('../src/alert-scheduler');
    const scheduleSpy = vi.spyOn(AlertScheduler.prototype, 'schedule');

    const magical = new CalendarService(
      () => [work, personal],
      () => {},
      async () => 'ok' as const,
    );
    magical.syncPollers();
    magical.pollNow();
    await flush();

    const scheduledFor = (sourceId: string) =>
      (
        scheduleSpy.mock.calls.filter(([id]) => id === sourceId).at(-1)?.[1] as
          NormalizedCalendarEvent[] | undefined
      )?.map((e) => e.id) ?? [];
    expect(scheduledFor('google:a')).toEqual([]);
    expect(scheduledFor('google:b')).toEqual(['dst_personal']);

    magical.stop();
    scheduleSpy.mockRestore();
  });

  it('re-arms cached alerts when settings change without requiring a network poll', async () => {
    const upcoming = new Date(Date.now() + 10 * 60_000);
    const primaryEvent = makeEvent('evt_primary', ['user@work.com'], upcoming);
    const secondaryEvent = makeEvent('evt_team', ['team@group.calendar.google.com'], upcoming);

    pollerEvents.set('google:a', [primaryEvent, secondaryEvent]);
    disabledAlertCalendarIds.mockReturnValue([]);

    const { AlertScheduler } = await import('../src/alert-scheduler');
    const scheduleSpy = vi.spyOn(AlertScheduler.prototype, 'schedule');

    const magical = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    magical.syncPollers();

    magical.pollNow();
    await flush();

    scheduleSpy.mockClear();

    // User disables alerts for the secondary calendar
    disabledAlertCalendarIds.mockReturnValue(['team@group.calendar.google.com']);
    magical.applySettings();

    // rearmCachedAlerts should immediately re-schedule without the muted calendar
    expect(scheduleSpy).toHaveBeenCalled();
    const rearmedEvents = scheduleSpy.mock.calls[0][1] as NormalizedCalendarEvent[];
    expect(rearmedEvents.map((e) => e.id)).toEqual(['evt_primary']);

    magical.stop();
    scheduleSpy.mockRestore();
  });

  it('re-arms armed alerts when the UTC offset changes between polls', async () => {
    const upcoming = new Date(Date.now() + 10 * 60_000);
    pollerEvents.set('google:a', [makeEvent('evt_primary', ['user@work.com'], upcoming)]);

    const { AlertScheduler } = await import('../src/alert-scheduler');
    const reconcileSpy = vi.spyOn(AlertScheduler.prototype, 'reconcile');

    const realOffset = Date.prototype.getTimezoneOffset;
    let offsetShift = 0;
    const offsetSpy = vi.spyOn(Date.prototype, 'getTimezoneOffset').mockImplementation(function (
      this: Date,
    ) {
      return realOffset.call(this) + offsetShift;
    });

    const magical = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    magical.syncPollers();

    magical.pollNow();
    await flush();
    expect(reconcileSpy).not.toHaveBeenCalled();

    // Crossing a DST boundary or a timezone while an alert is armed.
    offsetShift = 60;
    magical.pollNow();
    await flush();
    expect(reconcileSpy).toHaveBeenCalled();

    magical.stop();
    offsetSpy.mockRestore();
    reconcileSpy.mockRestore();
  });

  it('resolves canonical primary calendar ID when primary is muted', async () => {
    const upcoming = new Date(Date.now() + 10 * 60_000);
    // The wire names the calendar 'primary'; the user muted 'user@work.com'
    const primaryEvent = makeEvent('evt_primary_alias', ['primary'], upcoming);
    pollerEvents.set('google:a', [primaryEvent]);
    disabledAlertCalendarIds.mockReturnValue(['user@work.com']);

    const { AlertScheduler } = await import('../src/alert-scheduler');
    const scheduleSpy = vi.spyOn(AlertScheduler.prototype, 'schedule');

    const magical = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    magical.syncPollers();

    magical.pollNow();
    await flush();

    const scheduledEvents = scheduleSpy.mock.calls.at(-1)?.[1] as NormalizedCalendarEvent[];
    expect(scheduledEvents).toHaveLength(0);

    magical.stop();
    scheduleSpy.mockRestore();
  });
});

describe('a poll that fails', () => {
  const account = { id: 'a', name: 'Work', partition: 'pa', color: '#000' };
  const other = { id: 'b', name: 'Personal', partition: 'pb', color: '#111' };

  const invite = (id: string): NormalizedCalendarEvent => ({
    id,
    calendarIds: ['me@work.com'],
    summary: 'Design review',
    webUrl: 'https://www.google.com/calendar/event?eid=ABC',
    created: null,
    updated: null,
    startTime: inHours(24),
    endTime: inHours(25),
    isAllDay: false,
    myResponseStatus: 0,
    attendees: [],
    reminders: 'unknown',
  });

  beforeEach(() => {
    updateDockBadge.mockClear();
    pollerEvents.clear();
  });

  function serviceFor(accounts: (typeof account)[], onHealth = vi.fn()) {
    const service = new CalendarService(
      () => accounts,
      () => {},
      async () => 'ok' as const,
      undefined,
      onHealth,
    );
    service.syncPollers();
    return { service, onHealth };
  }

  it('tells the surfaces the network is gone, not that the calendar is broken', async () => {
    const { service, onHealth } = serviceFor([account]);
    pollerFailures.set('google:a', () => new FakeNetworkError('ERR_INTERNET_DISCONNECTED'));
    service.pollNow();

    await vi.waitFor(() => expect(onHealth).toHaveBeenCalledWith('a', 'offline', null));
    service.stop();
  });

  it('tells them which account needs signing in', async () => {
    const { service, onHealth } = serviceFor([account]);
    pollerFailures.set('google:a', () => new FakeSessionExpiredError());
    service.pollNow();

    await vi.waitFor(() => expect(onHealth).toHaveBeenCalledWith('a', 'signed-out', null));
    service.stop();
  });

  it('keeps a moved wire format separate from both', async () => {
    const { service, onHealth } = serviceFor([account]);
    pollerFailures.set('google:a', () => new Error('index 35 held a string'));
    service.pollNow();

    await vi.waitFor(() => expect(onHealth).toHaveBeenCalledWith('a', 'unreadable', null));
    service.stop();
  });

  it('holds the Dock badge rather than clearing it', async () => {
    pollerEvents.set('google:a', [invite('a1'), invite('a2')]);
    const { service } = serviceFor([account]);
    service.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenLastCalledWith(2));

    // The invitations did not go away; the poll did. Zeroing the badge here is the
    // silent failure this whole subsystem exists to prevent.
    pollerFailures.set('google:a', () => new FakeNetworkError('ERR_INTERNET_DISCONNECTED'));
    updateDockBadge.mockClear();
    service.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenCalled());
    expect(updateDockBadge).toHaveBeenLastCalledWith(2);

    service.stop();
  });

  it('keeps the events the last good read cached', async () => {
    pollerEvents.set('google:a', [invite('a1')]);
    const { service } = serviceFor([account]);
    service.pollNow();
    await vi.waitFor(() => expect(service.getCachedEvents().get('a')).toHaveLength(1));

    pollerFailures.set('google:a', () => new FakeNetworkError('ERR_NAME_NOT_RESOLVED'));
    service.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenCalled());
    // An agenda that empties the moment the wifi drops is worse than one that admits it
    // is behind.
    expect(service.getCachedEvents().get('a')).toHaveLength(1);

    service.stop();
  });

  it('leaves the account that still reads alone', async () => {
    pollerEvents.set('google:a', [invite('a1')]);
    pollerEvents.set('google:b', [invite('b1')]);
    const { service, onHealth } = serviceFor([account, other]);
    pollerFailures.set('google:a', () => new FakeNetworkError('ERR_INTERNET_DISCONNECTED'));
    service.pollNow();

    await vi.waitFor(() => expect(onHealth).toHaveBeenCalledWith('a', 'offline', null));
    expect(onHealth).toHaveBeenCalledWith('b', 'ok', expect.any(Date));
    expect(service.getCachedEvents().get('b')).toHaveLength(1);

    service.stop();
  });

  it('reports ok again once the read succeeds', async () => {
    const { service, onHealth } = serviceFor([account]);
    pollerFailures.set('google:a', () => new FakeNetworkError('ERR_INTERNET_DISCONNECTED'));
    service.pollNow();
    await vi.waitFor(() => expect(onHealth).toHaveBeenCalledWith('a', 'offline', null));

    pollerFailures.clear();
    onHealth.mockClear();
    service.pollNow();
    await vi.waitFor(() => expect(onHealth).toHaveBeenCalledWith('a', 'ok', expect.any(Date)));

    service.stop();
  });
});

describe('the event cache across a restart', () => {
  const account = { id: 'a', name: 'Work', partition: 'pa', color: '#000' };
  const DAY = 86_400_000;

  const event = (id: string, startsInDays: number): NormalizedCalendarEvent => ({
    id,
    calendarIds: ['me@work.com'],
    summary: 'Design review',
    webUrl: 'https://www.google.com/calendar/event?eid=ABC',
    created: null,
    updated: null,
    startTime: new Date(Date.now() + startsInDays * DAY),
    endTime: new Date(Date.now() + startsInDays * DAY + 3_600_000),
    isAllDay: false,
    myResponseStatus: 3,
    attendees: [],
    reminders: 'unknown',
  });

  const cacheFile = () => path.join(stateDir, 'event-cache.json');

  beforeEach(() => {
    updateDockBadge.mockClear();
    pollerEvents.clear();
  });

  async function pollOnce(accounts: (typeof account)[] = [account]) {
    const service = new CalendarService(
      () => accounts,
      () => {},
      async () => 'ok' as const,
    );
    service.syncPollers();
    service.pollNow();
    await vi.waitFor(() => expect(fs.existsSync(cacheFile())).toBe(true));
    service.stop();
    return service;
  }

  it('hands the next launch what the last good read saw', async () => {
    pollerEvents.set('google:a', [event('e1', 1), event('e2', 2)]);
    await pollOnce();

    // The second launch cannot reach Google at all, which is the case this exists for.
    pollerFailures.set('google:a', () => new FakeNetworkError('ERR_INTERNET_DISCONNECTED'));
    const next = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    // Seeded before any poll has answered: an agenda that is empty until the network
    // returns is the silent failure, not a fix for it.
    expect(next.getCachedEvents().get('a')).toHaveLength(2);
    next.stop();
  });

  it('keeps the seeded events when the first poll of the new launch fails', async () => {
    pollerEvents.set('google:a', [event('e1', 1)]);
    await pollOnce();

    pollerFailures.set('google:a', () => new FakeNetworkError('ERR_INTERNET_DISCONNECTED'));
    const next = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    next.syncPollers();
    next.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenCalled());
    expect(next.getCachedEvents().get('a')).toHaveLength(1);
    next.stop();
  });

  it('drops an account that has gone, so its diary is not drawn twice', async () => {
    // Removing and re-adding one Google account issues a new account id, and the old one's
    // events stayed in the cache: a second copy of every calendar the two shared, in the
    // fallback colour, and unreachable by a filter that names the account that remains.
    pollerEvents.set('google:a', [event('e1', 1)]);
    await pollOnce();

    const replacement = new CalendarService(
      () => [{ id: 'b', name: 'Replacement', partition: 'pb', color: '#000' }],
      () => {},
      async () => 'ok' as const,
    );
    replacement.syncPollers();

    expect(replacement.getCachedEvents().has('a')).toBe(false);
    replacement.stop();
    const written = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    expect(written.events.a).toBeUndefined();
  });

  it('writes only the days around now, not the whole poll window', async () => {
    pollerEvents.set('google:a', [event('near', 3), event('far', 200), event('old', -60)]);
    await pollOnce();

    const written = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    const ids = written.events.a.map((e: { id: string }) => e.id);
    // A year of events is megabytes written every poll to answer a month nobody is
    // looking at; what has to survive is the day in front of the user.
    expect(ids).toContain('near');
    expect(ids).not.toContain('far');
    expect(ids).not.toContain('old');
  });

  it('gives the times back as dates rather than strings', async () => {
    pollerEvents.set('google:a', [event('e1', 1)]);
    await pollOnce();

    const next = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    const revived = next.getCachedEvents().get('a')?.[0];
    // An event whose startTime came back a string alerts at NaN, which is worse than
    // not alerting: the timer never fires and nothing says why.
    expect(revived?.startTime).toBeInstanceOf(Date);
    expect(Number.isNaN(revived?.startTime.getTime())).toBe(false);
    next.stop();
  });

  it('drops an event whose time survived the file unusable', async () => {
    pollerEvents.set('google:a', [event('good', 1)]);
    await pollOnce();

    const written = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    written.events.a.push({ ...written.events.a[0], id: 'broken', startTime: 'not a time' });
    fs.writeFileSync(cacheFile(), JSON.stringify(written), 'utf8');

    const next = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    const ids = (next.getCachedEvents().get('a') ?? []).map((e) => e.id);
    expect(ids).toEqual(['good']);
    next.stop();
  });

  it('launches normally when the file is corrupt', async () => {
    fs.writeFileSync(cacheFile(), '{ not json', 'utf8');
    const next = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    // The cache is an optimisation for this launch, not something it needs.
    expect(next.getCachedEvents().size).toBe(0);
    next.stop();
  });

  it('does not rewrite the file when every account failed', async () => {
    pollerEvents.set('google:a', [event('e1', 1)]);
    await pollOnce();
    const before = fs.statSync(cacheFile()).mtimeMs;

    pollerFailures.set('google:a', () => new FakeNetworkError('ERR_INTERNET_DISCONNECTED'));
    const next = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    next.syncPollers();
    next.pollNow();
    await vi.waitFor(() => expect(updateDockBadge).toHaveBeenCalled());
    // A round that read nothing has learned nothing worth a megabyte of disk.
    expect(fs.statSync(cacheFile()).mtimeMs).toBe(before);
    next.stop();
  });

  describe('on a packaged build', () => {
    const stateFile = () => path.join(stateDir, 'alert-state.json');

    function packagedBuild(key: Buffer): void {
      configureSecretFiles({
        isPackaged: true,
        fetchKey: () => key,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      });
    }

    afterEach(() => {
      resetSecretFiles();
    });

    it('leaves no meeting title on disk', async () => {
      packagedBuild(Buffer.alloc(32, 1));
      pollerEvents.set('google:a', [event('e1', 1)]);
      await pollOnce();

      const bytes = fs.readFileSync(cacheFile());
      expect(bytes.subarray(0, 6).toString()).toBe('MAGBOX');
      expect(bytes.includes('Design review')).toBe(false);
    });

    it('still hands the next launch what the last good read saw', async () => {
      packagedBuild(Buffer.alloc(32, 1));
      pollerEvents.set('google:a', [event('e1', 1), event('e2', 2)]);
      await pollOnce();

      const next = new CalendarService(
        () => [account],
        () => {},
        async () => 'ok' as const,
      );
      expect(next.getCachedEvents().get('a')).toHaveLength(2);
      next.stop();
    });

    it('discards a cache the key no longer opens and refills it', async () => {
      packagedBuild(Buffer.alloc(32, 1));
      pollerEvents.set('google:a', [event('e1', 1)]);
      await pollOnce();

      // What a restored machine looks like: the file survived, the keychain item did not.
      packagedBuild(Buffer.alloc(32, 2));
      const next = new CalendarService(
        () => [account],
        () => {},
        async () => 'ok' as const,
      );
      expect(next.getCachedEvents().size).toBe(0);

      next.syncPollers();
      next.pollNow();
      await vi.waitFor(() => expect(next.getCachedEvents().get('a')).toHaveLength(1));
      next.stop();

      const reopened = new CalendarService(
        () => [account],
        () => {},
        async () => 'ok' as const,
      );
      expect(reopened.getCachedEvents().get('a')).toHaveLength(1);
      reopened.stop();
    });

    it('discards an alert record the key no longer opens', async () => {
      packagedBuild(Buffer.alloc(32, 1));
      pollerEvents.set('google:a', [
        { ...event('e1', 1), myResponseStatus: RESPONSE_NEEDS_ACTION },
      ]);
      await pollOnce();
      await vi.waitFor(() => expect(fs.existsSync(stateFile())).toBe(true));
      expect(fs.readFileSync(stateFile()).subarray(0, 6).toString()).toBe('MAGBOX');

      packagedBuild(Buffer.alloc(32, 2));
      const next = new CalendarService(
        () => [account],
        () => {},
        async () => 'ok' as const,
      );
      next.syncPollers();
      next.pollNow();
      // Starting from an empty record risks repeating one banner; refusing to launch
      // over it would cost every banner after.
      await vi.waitFor(() => expect(readSecretFile(stateFile())).not.toBeNull());
      next.stop();
    });
  });
});

describe('task completion sync and persistence', () => {
  const account = { id: 'a', name: 'Personal', partition: 'pa', color: '#000', gaiaId: '12345' };
  // Wider than anything the tests date events in, so the range never decides a case.
  const WIDE_RANGE = {
    start: new Date('2000-01-01T00:00:00Z'),
    end: new Date('2100-01-01T00:00:00Z'),
  };

  it('revives task completion state from the persisted cache', async () => {
    // Finished an hour and a half ago, and so inside the days of the past the cache
    // keeps. A task dated by a fixed string ages out of that window and is never written.
    const completedAt = inHours(-1.5);
    const task: NormalizedCalendarEvent = {
      id: 'task-1',
      calendarIds: ['tasks@tasks.google.com'],
      summary: 'Pay bills',
      created: null,
      updated: null,
      startTime: inHours(-2),
      endTime: inHours(-1),
      isAllDay: false,
      eventType: EVENT_TYPE.TASK,
      isCompleted: true,
      completedAt,
      myResponseStatus: 'notInvited',
    };

    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    (service as any).cachedEvents.set('a', [task]);
    (service as any).persistEventCache();

    const next = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );
    const revived = next.getCachedEvents().get('a');
    expect(revived).toHaveLength(1);
    expect(revived![0].isCompleted).toBe(true);
    expect(revived![0].completedAt?.toISOString()).toBe(completedAt.toISOString());
    next.stop();
    service.stop();
  });

  it('syncTasksCompletion overlays tasks completion from tasks poller', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    const taskEvents: NormalizedCalendarEvent[] = [
      {
        id: 'cal-event-1',
        calendarIds: ['tasks@tasks.google.com'],
        summary: 'Call dentist',
        created: null,
        updated: null,
        startTime: new Date('2026-09-17T10:00:00Z'),
        endTime: new Date('2026-09-17T11:00:00Z'),
        isAllDay: false,
        eventType: EVENT_TYPE.TASK,
        myResponseStatus: 'notInvited',
      },
    ];

    const mockFetchTasks = vi.fn().mockResolvedValue({
      tasksById: new Map(),
      tasks: new Map([
        [
          'cal-event-1',
          {
            taskId: 'tid-1',
            calendarEventId: 'cal-event-1',
            completed: true,
            completedAt: new Date('2026-09-17T10:15:00Z'),
          },
        ],
      ]),
      occurrences: [],
    });

    (service as any).tasksPollers.set('a', {
      fetchTasks: mockFetchTasks,
    });

    await (service as any).syncTasksCompletion('a', taskEvents, WIDE_RANGE);

    expect(taskEvents[0].isCompleted).toBe(true);
    expect(taskEvents[0].completedAt?.toISOString()).toBe('2026-09-17T10:15:00.000Z');
    service.stop();
  });

  it('preserves existing completion state if tasks poller fails', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    (service as any).cachedEvents.set('a', [
      {
        id: 'cal-event-1',
        calendarIds: ['tasks@tasks.google.com'],
        summary: 'Call dentist',
        startTime: new Date(),
        endTime: new Date(),
        eventType: EVENT_TYPE.TASK,
        isCompleted: true,
        completedAt: new Date('2026-09-17T10:15:00Z'),
      },
    ]);

    const freshFetched: NormalizedCalendarEvent[] = [
      {
        id: 'cal-event-1',
        calendarIds: ['tasks@tasks.google.com'],
        summary: 'Call dentist',
        created: null,
        updated: null,
        startTime: new Date(),
        endTime: new Date(),
        isAllDay: false,
        eventType: EVENT_TYPE.TASK,
        myResponseStatus: 'notInvited',
      },
    ];

    (service as any).tasksPollers.set('a', {
      fetchTasks: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    await (service as any).syncTasksCompletion('a', freshFetched, WIDE_RANGE);

    expect(freshFetched[0].isCompleted).toBe(true);
    expect(freshFetched[0].completedAt?.toISOString()).toBe('2026-09-17T10:15:00.000Z');
    service.stop();
  });

  it('clears a cached tick the sync does not confirm', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    (service as any).cachedEvents.set('a', [
      {
        id: 'cal-event-1',
        calendarIds: ['tasks@tasks.google.com'],
        summary: 'Call dentist',
        startTime: new Date(),
        endTime: new Date(),
        eventType: EVENT_TYPE.TASK,
        isCompleted: true,
        completedAt: new Date('2026-09-17T10:15:00Z'),
      },
    ]);

    const freshFetched: NormalizedCalendarEvent[] = [
      {
        id: 'cal-event-1',
        calendarIds: ['tasks@tasks.google.com'],
        summary: 'Call dentist',
        created: null,
        updated: null,
        startTime: new Date(),
        endTime: new Date(),
        isAllDay: false,
        eventType: EVENT_TYPE.TASK,
        myResponseStatus: 'notInvited',
      },
    ];

    // The task was reopened in the browser, so Google's answer no longer holds it as
    // complete. Without this the popover greyed the row out for good.
    (service as any).tasksPollers.set('a', {
      fetchTasks: vi.fn().mockResolvedValue({
        tasksById: new Map(),
        tasks: new Map([
          [
            'cal-event-1',
            {
              taskId: 'tid-1',
              calendarEventId: 'cal-event-1',
              completed: false,
              completedAt: null,
            },
          ],
        ]),
        occurrences: [],
      }),
    });

    await (service as any).syncTasksCompletion('a', freshFetched, WIDE_RANGE);

    expect(freshFetched[0].isCompleted).toBe(false);
    expect(freshFetched[0].completedAt).toBeNull();
    service.stop();
  });

  it('keeps a completion the user just asked for when the sync has not caught up', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    const task: NormalizedCalendarEvent = {
      id: 'cal-event-1',
      calendarIds: ['tasks@tasks.google.com'],
      summary: 'Call dentist',
      created: null,
      updated: null,
      startTime: new Date(),
      endTime: new Date(),
      isAllDay: false,
      eventType: EVENT_TYPE.TASK,
      myResponseStatus: 'notInvited',
    };
    (service as any).cachedEvents.set('a', [task]);
    (service as any).applyLocalCompletion('a', task, true);

    // Google Tasks has not recorded the click yet, and the poll that follows it answers
    // in well under a second.
    (service as any).tasksPollers.set('a', {
      fetchTasks: vi
        .fn()
        .mockResolvedValue({ tasks: new Map(), tasksById: new Map(), occurrences: [] }),
    });

    await (service as any).syncTasksCompletion('a', [task], WIDE_RANGE);

    expect(task.isCompleted).toBe(true);
    service.stop();
  });

  it('lets the sync settle a completion once the grace window has passed', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    const task: NormalizedCalendarEvent = {
      id: 'cal-event-1',
      calendarIds: ['tasks@tasks.google.com'],
      summary: 'Call dentist',
      created: null,
      updated: null,
      startTime: new Date(),
      endTime: new Date(),
      isAllDay: false,
      eventType: EVENT_TYPE.TASK,
      myResponseStatus: 'notInvited',
    };
    (service as any).cachedEvents.set('a', [task]);
    (service as any).applyLocalCompletion('a', task, true);
    (service as any).recentCompletions.set('a:cal-event-1', Date.now() - 1);

    // Google holds the task open: the completion never reached it.
    (service as any).tasksPollers.set('a', {
      fetchTasks: vi.fn().mockResolvedValue({
        tasksById: new Map(),
        tasks: new Map([
          [
            'cal-event-1',
            {
              taskId: 'tid-1',
              calendarEventId: 'cal-event-1',
              completed: false,
              completedAt: null,
            },
          ],
        ]),
        occurrences: [],
      }),
    });

    await (service as any).syncTasksCompletion('a', [task], WIDE_RANGE);

    expect(task.isCompleted).toBe(false);
    service.stop();
  });

  it('clears a cached tick for a task the sync never mentions', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    (service as any).cachedEvents.set('a', [
      {
        id: 'cal-event-1',
        calendarIds: ['tasks@tasks.google.com'],
        summary: 'Call dentist',
        startTime: new Date(),
        endTime: new Date(),
        eventType: EVENT_TYPE.TASK,
        isCompleted: true,
        completedAt: new Date('2026-09-17T10:15:00Z'),
      },
    ]);

    const freshFetched: NormalizedCalendarEvent[] = [
      {
        id: 'cal-event-1',
        calendarIds: ['tasks@tasks.google.com'],
        summary: 'Call dentist',
        created: null,
        updated: null,
        startTime: new Date(),
        endTime: new Date(),
        isAllDay: false,
        eventType: EVENT_TYPE.TASK,
        myResponseStatus: 'notInvited',
      },
      {
        id: 'cal-event-2',
        calendarIds: ['tasks@tasks.google.com'],
        summary: 'Book dentist',
        created: null,
        updated: null,
        startTime: new Date(),
        endTime: new Date(),
        isAllDay: false,
        eventType: EVENT_TYPE.TASK,
        myResponseStatus: 'notInvited',
      },
    ];

    // The sync names the second task, so it is plainly an answer about this account's
    // tasks, and the first one's absence from it means something.
    (service as any).tasksPollers.set('a', {
      fetchTasks: vi.fn().mockResolvedValue({
        tasksById: new Map(),
        tasks: new Map([
          [
            'cal-event-2',
            {
              taskId: 'tid-2',
              calendarEventId: 'cal-event-2',
              completed: false,
              completedAt: null,
            },
          ],
        ]),
        occurrences: [],
      }),
    });

    await (service as any).syncTasksCompletion('a', freshFetched, WIDE_RANGE);

    expect(freshFetched[0].isCompleted).toBe(false);
    expect(freshFetched[0].completedAt).toBeNull();
    service.stop();
  });

  it('draws an occurrence of a recurring task, which the calendar feed never carries', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    (service as any).tasksPollers.set('a', {
      fetchTasks: vi.fn().mockResolvedValue({
        tasksById: new Map(),
        tasks: new Map(),
        occurrences: [
          {
            taskId: 'occurrence-1',
            title: 'Weekly review',
            recurrenceId: 'rec-1',
            startTime: new Date('2026-09-23T16:30:00Z'),
            isAllDay: false,
            timezone: 'Europe/London',
            completed: false,
            completedAt: null,
          },
        ],
      }),
    });

    const fetched: NormalizedCalendarEvent[] = [];
    await (service as any).syncTasksCompletion('a', fetched, WIDE_RANGE);

    expect(fetched).toHaveLength(1);
    expect(fetched[0].summary).toBe('Weekly review');
    expect(fetched[0].eventType).toBe(EVENT_TYPE.TASK);
    expect(fetched[0].calendarIds).toEqual(['tasks@tasks.google.com']);
    expect(fetched[0].startTime.toISOString()).toBe('2026-09-23T16:30:00.000Z');
    // An hour, the way Google draws a task with a time of day.
    expect(fetched[0].endTime.getTime() - fetched[0].startTime.getTime()).toBe(3_600_000);
    expect(fetched[0].fromTasksSync).toBe(true);
    // The grid names an occurrence's chip by its Tasks id, which is what lets a link
    // reach it and the complete control be driven on it.
    expect(fetched[0].chipEid).toBe('tasks_occurrence-1');
    expect(buildEventLink(fetched[0], 'a')).toContain('eid=tasks_occurrence-1');
    service.stop();
  });

  it('draws the tasks Google draws nowhere, finished one included, and never duplicates a bound one', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    // Two tasks the read holds: one Google draws on the calendar, and one date-only task
    // it draws nowhere. A third is finished, and Tasks holds no row to draw for it.
    (service as any).tasksPollers.set('a', {
      fetchTasks: vi.fn().mockResolvedValue({
        tasks: new Map([
          [
            'cal-event-1',
            {
              taskId: 'tid-bound',
              calendarEventId: 'cal-event-1',
              completed: false,
              completedAt: null,
            },
          ],
        ]),
        tasksById: new Map([
          [
            'tid-bound',
            {
              taskId: 'tid-bound',
              title: 'Book the dentist',
              calendarEventId: 'cal-event-1',
              startTime: new Date('2026-09-23T16:30:00Z'),
              isAllDay: false,
              completed: false,
              completedAt: null,
            },
          ],
          [
            'tid-date-only',
            {
              taskId: 'tid-date-only',
              title: 'Post the form',
              calendarEventId: null,
              startTime: new Date('2026-09-24T00:00:00Z'),
              isAllDay: true,
              completed: false,
              completedAt: null,
            },
          ],
          [
            'tid-finished',
            {
              taskId: 'tid-finished',
              title: 'Pay the invoice',
              calendarEventId: null,
              startTime: new Date('2026-09-24T00:00:00Z'),
              isAllDay: true,
              completed: true,
              completedAt: new Date('2026-09-24T09:00:00Z'),
            },
          ],
        ]),
        occurrences: [],
      }),
    });

    const fetched: NormalizedCalendarEvent[] = [];
    await (service as any).syncTasksCompletion('a', fetched, WIDE_RANGE);

    // The bound task is already drawn from the range feed under the event it is drawn as,
    // so it is skipped here: drawing it again would list it twice. Both of the tasks
    // Google draws nowhere are added, the finished one included, because what hides a
    // completed task is the popover's own setting rather than this.
    expect(fetched).toHaveLength(2);
    const open = fetched.find((e) => e.id === 'tid-date-only');
    const finished = fetched.find((e) => e.id === 'tid-finished');
    if (!open || !finished) throw new Error('both unbound tasks should be drawn');

    expect(open.summary).toBe('Post the form');
    expect(open.eventType).toBe(EVENT_TYPE.TASK);
    expect(open.calendarIds).toEqual(['tasks@tasks.google.com']);
    expect(open.fromTasksSync).toBe(true);
    expect(open.isAllDay).toBe(true);
    expect(open.startTime.toISOString()).toBe('2026-09-24T00:00:00.000Z');
    // A day, the way Google draws a task with a date and no time of day.
    expect(open.endTime.getTime() - open.startTime.getTime()).toBe(86_400_000);
    // The grid draws it under the Tasks id, which is what a link reaches it by and what
    // the task write resolves through — the chip carries the id, so no read is needed.
    expect(open.chipEid).toBe('tasks_tid-date-only');
    expect(extractEid(open)).toBe('tasks_tid-date-only');
    expect(buildEventLink(open, 'a')).toContain('eid=tasks_tid-date-only');

    // Ticked off, and still a row: the tick has to have something to undo it from.
    expect(finished.chipEid).toBe('tasks_tid-finished');
    expect(finished.isCompleted).toBe(true);
    expect(finished.completedAt?.toISOString()).toBe('2026-09-24T09:00:00.000Z');
    service.stop();
  });

  it('alerts an occurrence at its own time, the way a one-off task does', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    (service as any).tasksPollers.set('a', {
      fetchTasks: vi.fn().mockResolvedValue({
        tasksById: new Map(),
        tasks: new Map(),
        occurrences: [
          {
            taskId: 'occurrence-1',
            title: 'Weekly review',
            recurrenceId: 'rec-1',
            startTime: new Date('2026-09-23T16:30:00Z'),
            isAllDay: false,
            timezone: 'Europe/London',
            completed: false,
            completedAt: null,
          },
        ],
      }),
    });

    const fetched: NormalizedCalendarEvent[] = [];
    await (service as any).syncTasksCompletion('a', fetched, WIDE_RANGE);

    // A due time is the moment, not some minutes before it, and the global lead would
    // make it the latter.
    expect(fetched[0].reminders).toEqual([0]);
    expect(isAlertable(fetched[0])).toBe(true);
    service.stop();
  });

  it('leaves out an occurrence that falls outside the range being fetched', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    (service as any).tasksPollers.set('a', {
      fetchTasks: vi.fn().mockResolvedValue({
        tasksById: new Map(),
        tasks: new Map(),
        occurrences: [
          {
            taskId: 'occurrence-far',
            title: 'Weekly review',
            recurrenceId: 'rec-1',
            startTime: new Date('2027-05-01T09:00:00Z'),
            isAllDay: false,
            timezone: 'Europe/London',
            completed: false,
            completedAt: null,
          },
        ],
      }),
    });

    const fetched: NormalizedCalendarEvent[] = [];
    await (service as any).syncTasksCompletion('a', fetched, {
      start: new Date('2026-09-01T00:00:00Z'),
      end: new Date('2026-10-01T00:00:00Z'),
    });

    expect(fetched).toHaveLength(0);
    service.stop();
  });

  it('leaves every tick alone when the sync names none of the tasks', async () => {
    const service = new CalendarService(
      () => [account],
      () => {},
      async () => 'ok' as const,
    );

    const task: NormalizedCalendarEvent = {
      id: 'cal-event-1',
      calendarIds: ['tasks@tasks.google.com'],
      summary: 'Call dentist',
      created: null,
      updated: null,
      startTime: new Date(),
      endTime: new Date(),
      isAllDay: false,
      eventType: EVENT_TYPE.TASK,
      isCompleted: true,
      completedAt: new Date('2026-09-17T10:15:00Z'),
      myResponseStatus: 'notInvited',
    };
    (service as any).cachedEvents.set('a', [task]);

    // Tasks holds a record for an open task as much as a finished one, so an answer
    // naming none of them is a decode that failed rather than an empty account.
    (service as any).tasksPollers.set('a', {
      fetchTasks: vi
        .fn()
        .mockResolvedValue({ tasks: new Map(), tasksById: new Map(), occurrences: [] }),
    });

    await (service as any).syncTasksCompletion('a', [task], WIDE_RANGE);

    expect(task.isCompleted).toBe(true);
    service.stop();
  });
});
