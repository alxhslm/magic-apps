import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const mockSendToHelper = vi.fn();
const mockIsHelperAvailable = vi.fn().mockReturnValue(true);
const mockShellOpenExternal = vi.fn().mockResolvedValue(undefined);
const mockLoadSettings = vi.fn().mockReturnValue({
  isCalendarCollapsed: false,
  menuBarDisplayMode: 'iconOnly',
  showMenuBarAccountColor: true,
  showCompletedTasks: true,
});
const mockSaveSetting = vi.fn();

const mockAppFocus = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: () => '/mock/userdata',
    focus: (...args: unknown[]) => mockAppFocus(...args),
  },
  shell: { openExternal: (url: string) => mockShellOpenExternal(url) },
}));

vi.mock('../src/swift-helper.js', () => ({
  sendToHelper: (...args: unknown[]) => mockSendToHelper(...args),
  isHelperAvailable: () => mockIsHelperAvailable(),
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: () => mockLoadSettings(),
  saveSetting: (...args: unknown[]) => mockSaveSetting(...args),
}));

vi.mock('../src/widget-cache.js', () => ({
  buildWidgetCache: () => ({ updatedAt: 0, events: [], densityDots: {} }),
  writeWidgetCache: () => false,
}));

const { MenuBarManager } = await import('../src/menubar-manager.js');

describe('Magical Tray Payload Contracts', () => {
  const fixturesDir = path.join(__dirname, 'fixtures');

  let manager: InstanceType<typeof MenuBarManager>;
  let mockWindow: { show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
  let mockAccountsManager: {
    switchAccount: ReturnType<typeof vi.fn>;
    openInAccount: ReturnType<typeof vi.fn>;
    getActiveAccountId: ReturnType<typeof vi.fn>;
    revealEvent: ReturnType<typeof vi.fn>;
  };
  let mockCalendarService: {
    answerRsvp: ReturnType<typeof vi.fn>;
    deleteEvent: ReturnType<typeof vi.fn>;
    setTaskCompleted: ReturnType<typeof vi.fn>;
    pendingByAccount: ReturnType<typeof vi.fn>;
    openDeepLink: ReturnType<typeof vi.fn>;
    joinCall: ReturnType<typeof vi.fn>;
    ensureRange: ReturnType<typeof vi.fn>;
    refreshIfStale: ReturnType<typeof vi.fn>;
    pollNow: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1789750800000));
    mockWindow = { show: vi.fn(), focus: vi.fn() };
    mockAccountsManager = {
      switchAccount: vi.fn(),
      openInAccount: vi.fn(),
      getActiveAccountId: vi.fn().mockReturnValue('account_work'),
      revealEvent: vi.fn().mockResolvedValue('revealed'),
    };
    mockCalendarService = {
      answerRsvp: vi.fn().mockResolvedValue('ok'),
      deleteEvent: vi.fn().mockResolvedValue(true),
      setTaskCompleted: vi.fn().mockResolvedValue(true),
      pendingByAccount: vi.fn().mockReturnValue(new Map()),
      openDeepLink: vi.fn().mockReturnValue(true),
      joinCall: vi.fn().mockResolvedValue(undefined),
      ensureRange: vi.fn().mockResolvedValue(undefined),
      refreshIfStale: vi.fn(),
      pollNow: vi.fn(),
    };

    manager = new MenuBarManager(
      () => mockWindow as never,
      () => mockAccountsManager as never,
      () => mockCalendarService as never,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('validates tray-update.json structure matches the schema emitted by main process', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-update.json'), 'utf8');
    const fixture = JSON.parse(raw);

    expect(Array.isArray(fixture.accounts)).toBe(true);
    expect(fixture.accounts.length).toBeGreaterThan(0);
    for (const acc of fixture.accounts) {
      expect(typeof acc.id).toBe('string');
      expect(typeof acc.name).toBe('string');
      expect(typeof acc.color).toBe('string');
      expect(typeof acc.unreadCount).toBe('number');
      expect(typeof acc.email).toBe('string');
      expect(typeof acc.needsAuth).toBe('boolean');
    }

    expect(Array.isArray(fixture.calendars)).toBe(true);
    for (const cal of fixture.calendars) {
      expect(typeof cal.id).toBe('string');
      expect(typeof cal.accountId).toBe('string');
      expect(typeof cal.name).toBe('string');
      expect(typeof cal.colorHex).toBe('string');
    }

    expect(Array.isArray(fixture.events)).toBe(true);
    expect(fixture.events.length).toBeGreaterThan(0);
    for (const ev of fixture.events) {
      expect(typeof ev.id).toBe('string');
      expect(typeof ev.accountId).toBe('string');
      expect(Array.isArray(ev.calendarIds)).toBe(true);
      expect(typeof ev.summary).toBe('string');
      expect(typeof ev.startTime).toBe('number');
      expect(typeof ev.endTime).toBe('number');
      expect(typeof ev.isAllDay).toBe('boolean');
      expect(typeof ev.eventType).toBe('number');
      expect(typeof ev.colorHex).toBe('string');
      expect(typeof ev.myResponseStatus).toBe('number');
      if (ev.conferenceUrl !== undefined) expect(typeof ev.conferenceUrl).toBe('string');
      if (ev.location !== undefined) expect(typeof ev.location).toBe('string');
      if (ev.isCompleted !== undefined) expect(typeof ev.isCompleted).toBe('boolean');
      if (ev.deepLink !== undefined) expect(typeof ev.deepLink).toBe('string');
      if (ev.webUrl !== undefined) expect(typeof ev.webUrl).toBe('string');
    }

    expect(typeof fixture.activeAccountId).toBe('string');
    expect(typeof fixture.isCalendarCollapsed).toBe('boolean');
    expect(typeof fixture.isOffline).toBe('boolean');
    expect(typeof fixture.menuBarDisplayMode).toBe('string');
    expect(typeof fixture.showMenuBarAccountColor).toBe('boolean');
    expect(Array.isArray(fixture.hiddenCalendars)).toBe(true);
    expect(typeof fixture.showCompletedTasks).toBe('boolean');
  });

  it('emits tray.update payload from pushUpdate matching wire schema and includes lastSyncedAt for stalled accounts', () => {
    manager.createTray();
    mockSendToHelper.mockClear();

    manager.updateAccounts([
      {
        id: 'account_work',
        name: 'Work',
        color: '#0096ff',
        email: 'taylor@example.com',
        calendarIds: ['taylor@example.com'],
      } as never,
    ]);

    manager.updateEvents(
      new Map([
        [
          'account_work',
          [
            {
              id: 'evt_standup_001',
              summary: 'Standup',
              startTime: new Date(1789750800000),
              endTime: new Date(1789752600000),
              isAllDay: false,
              calendarIds: ['taylor@example.com'],
              eventType: 0,
              colorHex: '#039be5',
              myResponseStatus: 3,
              conferenceUrl: 'https://meet.google.com/abc-defg-hij',
              location: 'Room 3B',
              organizerEmail: 'lead@example.com',
              webUrl: 'https://calendar.google.com/event?eid=abc',
            } as never,
          ],
        ],
      ]),
    );

    // Stalled account emits lastSyncedAt timestamp in ms and offline flag when all accounts offline
    manager.setAccountHealth('account_work', 'offline', new Date(1789750800000));

    expect(mockSendToHelper).toHaveBeenCalledWith(
      'tray.update',
      expect.objectContaining({
        accounts: [
          {
            id: 'account_work',
            name: 'Work',
            color: '#0096ff',
            email: 'taylor@example.com',
            unreadCount: 0,
            needsAuth: false,
          },
        ],
        events: [
          expect.objectContaining({
            id: 'evt_standup_001',
            accountId: 'account_work',
            summary: 'Standup',
            startTime: 1789750800000,
            endTime: 1789752600000,
            isAllDay: false,
            eventType: 0,
            colorHex: '#039be5',
            myResponseStatus: 3,
            conferenceUrl: 'https://meet.google.com/abc-defg-hij',
            location: 'Room 3B',
            organizerEmail: 'lead@example.com',
          }),
        ],
        activeAccountId: 'account_work',
        isOffline: true,
        lastSyncedAt: 1789750800000,
        isCalendarCollapsed: false,
        menuBarDisplayMode: 'iconOnly',
        showMenuBarAccountColor: true,
        showCompletedTasks: true,
      }),
    );
  });

  it('handles tray.rsvp using tray-rsvp.json fixture', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-rsvp.json'), 'utf8');
    const fixture = JSON.parse(raw);

    const handled = manager.handleEvent('tray.rsvp', fixture);
    expect(handled).toBe(true);
    expect(mockCalendarService.answerRsvp).toHaveBeenCalledWith(
      fixture.accountId,
      fixture.eventId,
      fixture.response,
    );
  });

  it('handles tray.setTaskCompleted using tray-set-task-completed.json fixture', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-set-task-completed.json'), 'utf8');
    const fixture = JSON.parse(raw);

    const handled = manager.handleEvent('tray.setTaskCompleted', fixture);
    expect(handled).toBe(true);
    expect(mockCalendarService.setTaskCompleted).toHaveBeenCalledWith(
      fixture.accountId,
      fixture.eventId,
      fixture.completed,
    );
  });

  it('handles tray.deleteEvent using tray-delete-event.json fixture', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-delete-event.json'), 'utf8');
    const fixture = JSON.parse(raw);

    const handled = manager.handleEvent('tray.deleteEvent', fixture);
    expect(handled).toBe(true);
    expect(mockCalendarService.deleteEvent).toHaveBeenCalledWith(
      fixture.accountId,
      fixture.eventId,
    );
  });

  it('handles tray.focusEvent using tray-focus-event.json fixture', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-focus-event.json'), 'utf8');
    const fixture = JSON.parse(raw);

    // Uncached event falls back to switching to the account
    const handled = manager.handleEvent('tray.focusEvent', fixture);
    expect(handled).toBe(true);
    expect(mockAccountsManager.switchAccount).toHaveBeenCalledWith(fixture.accountId);
    expect(mockAppFocus).toHaveBeenCalledWith({ steal: true });
    expect(mockWindow.show).toHaveBeenCalled();
    expect(mockWindow.focus).toHaveBeenCalled();

    // When event is cached, it opens the deep link to the event
    manager.updateEvents(
      new Map([
        [
          fixture.accountId,
          [
            {
              id: fixture.eventId,
              chipEid: fixture.eventId,
              summary: 'Standup',
              startTime: new Date('2026-09-25T09:00:00Z'),
              endTime: new Date('2026-09-25T09:30:00Z'),
              isAllDay: false,
              calendarId: 'cal_work_primary',
              eventType: 'default',
            } as never,
          ],
        ],
      ]),
    );
    mockAppFocus.mockClear();
    mockWindow.show.mockClear();
    mockWindow.focus.mockClear();

    const handledCached = manager.handleEvent('tray.focusEvent', fixture);
    expect(handledCached).toBe(true);
    expect(mockCalendarService.openDeepLink).toHaveBeenCalledWith(
      expect.stringContaining(fixture.eventId),
    );
    expect(mockAppFocus).toHaveBeenCalledWith({ steal: true });
    expect(mockWindow.show).toHaveBeenCalled();
    expect(mockWindow.focus).toHaveBeenCalled();
  });

  it('handles tray.showAccount using tray-show-account.json fixture', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'tray-show-account.json'), 'utf8');
    const fixture = JSON.parse(raw);

    const handled = manager.handleEvent('tray.showAccount', fixture);
    expect(handled).toBe(true);
    expect(mockAccountsManager.switchAccount).toHaveBeenCalledWith(fixture.accountId);
    expect(mockWindow.show).toHaveBeenCalled();
    expect(mockWindow.focus).toHaveBeenCalled();
  });

  it('handles tray.joinCall and routes to CalendarService.joinCall', () => {
    const handled = manager.handleEvent('tray.joinCall', {
      url: 'https://meet.google.com/abc-defg-hij',
    });
    expect(handled).toBe(true);
    expect(mockCalendarService.joinCall).toHaveBeenCalledWith(
      'https://meet.google.com/abc-defg-hij',
    );
  });

  it('handles tray.search, tray.refresh, and tray.popoverOpened', () => {
    const mockOnSearch = vi.fn();
    const searchableManager = new MenuBarManager(
      () => mockWindow as never,
      () => mockAccountsManager as never,
      () => mockCalendarService as never,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      mockOnSearch,
    );

    searchableManager.handleEvent('tray.search', { query: 'standup', accountId: 'account_work' });
    expect(mockOnSearch).toHaveBeenCalledWith('standup', 'account_work');

    searchableManager.handleEvent('tray.refresh', {});
    expect(mockCalendarService.pollNow).toHaveBeenCalled();

    searchableManager.handleEvent('tray.popoverOpened', {});
    expect(mockCalendarService.refreshIfStale).toHaveBeenCalled();
  });

  it('handles tray preferences: collapsed calendar, completed tasks, and hidden calendars', () => {
    manager.handleEvent('tray.setCalendarCollapsed', { isCollapsed: true });
    expect(mockSaveSetting).toHaveBeenCalledWith('isCalendarCollapsed', true);

    manager.handleEvent('tray.setShowCompletedTasks', { showCompletedTasks: false });
    expect(mockSaveSetting).toHaveBeenCalledWith('showCompletedTasks', false);

    const hidden = [{ accountId: 'account_work', calendarId: 'cal_team' }];
    manager.handleEvent('tray.setHiddenCalendars', { hiddenCalendars: hidden });
    expect(mockSaveSetting).toHaveBeenCalledWith('hiddenCalendars', hidden);
  });
});
