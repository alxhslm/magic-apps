import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CalendarAccount } from '../src/accounts.js';
import type { NormalizedCalendarEvent } from '../src/calendar-decoder.js';

const mockSendToHelper = vi.fn().mockResolvedValue('ok');
const mockIsHelperAvailable = vi.fn().mockReturnValue(true);
const mockShellOpenExternal = vi.fn();
const mockAppQuit = vi.fn();
const mockSaveSetting = vi.fn();
const mockLoadSettings = vi.fn().mockReturnValue({
  isCalendarCollapsed: false,
  menuBarDisplayMode: 'nextEvent',
  showMenuBarAccountColor: true,
  hiddenCalendarIds: [],
  showCompletedTasks: false,
});

vi.mock('electron', () => ({
  app: { quit: () => mockAppQuit(), focus: vi.fn() },
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

const mockBuildWidgetCache = vi.fn().mockReturnValue({ updatedAt: 0, events: [], densityDots: {} });

vi.mock('../src/widget-cache.js', () => ({
  buildWidgetCache: (...args: unknown[]) => mockBuildWidgetCache(...args),
  writeWidgetCache: () => false,
}));

const { MenuBarManager } = await import('../src/menubar-manager.js');

describe('MenuBarManager', () => {
  let manager: InstanceType<typeof MenuBarManager>;
  let mockWindow: { show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };
  let mockAccountsManager: {
    switchAccount: ReturnType<typeof vi.fn>;
    openInAccount: ReturnType<typeof vi.fn>;
  };
  let mockCalendarService: {
    answerRsvp: ReturnType<typeof vi.fn>;
  };
  let mockOnNewEvent: ReturnType<typeof vi.fn>;
  let mockOnOpenSettings: ReturnType<typeof vi.fn>;
  let mockOnOpenApp: ReturnType<typeof vi.fn>;
  let mockOnSearch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
    mockWindow = { show: vi.fn(), focus: vi.fn() };
    mockAccountsManager = {
      switchAccount: vi.fn(),
      openInAccount: vi.fn(),
      getActiveAccountId: vi.fn().mockReturnValue('acc_work'),
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
    mockOnNewEvent = vi.fn();
    mockOnOpenSettings = vi.fn();
    mockOnOpenApp = vi.fn();
    mockOnSearch = vi.fn();

    manager = new MenuBarManager(
      () => mockWindow as never,
      () => mockAccountsManager as never,
      () => mockCalendarService as never,
      mockOnNewEvent,
      mockOnOpenSettings,
      mockOnOpenApp,
      mockOnSearch,
    );
  });

  it('creates the tray and pushes initial update', () => {
    manager.createTray();
    expect(manager.isCreated()).toBe(true);
    expect(mockSendToHelper).toHaveBeenCalledWith('tray.create');
  });

  it('passes activeAccountId in tray.update', () => {
    manager.createTray();
    expect(mockSendToHelper).toHaveBeenCalledWith(
      'tray.update',
      expect.objectContaining({ activeAccountId: 'acc_work' }),
    );
  });

  it('destroys the tray when requested', () => {
    manager.createTray();
    manager.destroyTray();
    expect(manager.isCreated()).toBe(false);
    expect(mockSendToHelper).toHaveBeenCalledWith('tray.destroy');
  });

  it('serializes events with their calendar’s colour and pending RSVP counts', () => {
    // The count is the calendar service's, not the tray's own tally of the event cache:
    // one pile, one counter, so the popover cannot drift from the Dock badge.
    mockCalendarService.pendingByAccount.mockReturnValue(new Map([['acc_work', 1]]));
    manager.createTray();

    const accounts: CalendarAccount[] = [
      {
        id: 'acc_work',
        name: 'Work',
        color: '#039be5',
        partition: 'persist:magical_work',
        email: 'work@example.com',
        calendars: [{ id: 'cal_work', name: 'Team Standup', color: '#7cb342' }],
      },
    ];

    const now = new Date('2026-09-16T14:00:00Z');
    const later = new Date('2026-09-16T15:00:00Z');

    const events: NormalizedCalendarEvent[] = [
      {
        id: 'event_1',
        calendarIds: ['cal_work'],
        calendarName: 'Team Standup',
        summary: 'Daily Sprint',
        webUrl: 'https://calendar.google.com/calendar/r/eventedit/123',
        created: now,
        updated: now,
        startTime: now,
        endTime: later,
        isAllDay: false,
        attendees: [],
        myResponseStatus: 0, // Needs action / unread RSVP
        conferenceUrl: 'https://meet.google.com/abc-defg-hij',
        reminders: [],
      },
    ];

    const eventsMap = new Map<string, NormalizedCalendarEvent[]>([['acc_work', events]]);

    manager.updateAccounts(accounts);
    manager.updateEvents(eventsMap);

    expect(mockSendToHelper).toHaveBeenCalledWith(
      'tray.update',
      expect.objectContaining({
        accounts: [
          {
            id: 'acc_work',
            name: 'Work',
            color: '#039be5',
            email: 'work@example.com',
            unreadCount: 1,
            needsAuth: false,
          },
        ],
        events: [
          expect.objectContaining({
            id: 'event_1',
            accountId: 'acc_work',
            calendarIds: ['cal_work'],
            calendarName: 'Team Standup',
            summary: 'Daily Sprint',
            colorHex: '#7cb342',
            myResponseStatus: 0,
            startTime: now.getTime(),
            endTime: later.getTime(),
          }),
        ],
        isCalendarCollapsed: false,
        isOffline: false,
      }),
    );
  });

  it('handles tray.openApp by focusing existing window or recreating if closed', () => {
    manager.handleEvent('tray.openApp', {});
    expect(mockWindow.show).toHaveBeenCalled();
    expect(mockWindow.focus).toHaveBeenCalled();

    // When window is null
    const closedManager = new MenuBarManager(
      () => null,
      () => null,
      () => null,
      mockOnNewEvent,
      mockOnOpenSettings,
      mockOnOpenApp,
    );
    closedManager.handleEvent('tray.openApp', {});
    expect(mockOnOpenApp).toHaveBeenCalled();
  });

  it('switches the account in place in the popover when there is a window', () => {
    manager.handleEvent('tray.showAccount', { accountId: 'acc_work' });

    expect(mockAccountsManager.switchAccount).toHaveBeenCalledWith('acc_work');
    expect(mockWindow.show).toHaveBeenCalled();
    expect(mockOnOpenApp).not.toHaveBeenCalled();
  });

  it('opens the window on the account when the popover row arrives with no window', () => {
    // No manager to switch with, so the window is opened on that account.
    const closedManager = new MenuBarManager(
      () => null,
      () => null,
      () => null,
      mockOnNewEvent,
      mockOnOpenSettings,
      mockOnOpenApp,
    );

    closedManager.handleEvent('tray.showAccount', { accountId: 'acc_work' });

    expect(mockOnOpenApp).toHaveBeenCalledWith('acc_work');
  });

  it('forwards the menu bar display settings the helper renders the title from', () => {
    manager.createTray();

    expect(mockSendToHelper).toHaveBeenCalledWith(
      'tray.update',
      expect.objectContaining({ menuBarDisplayMode: 'nextEvent', showMenuBarAccountColor: true }),
    );
  });

  it('sends the colour off when the user turns it off', () => {
    manager.createTray();
    mockLoadSettings.mockReturnValueOnce({
      isCalendarCollapsed: false,
      menuBarDisplayMode: 'nextEvent',
      showMenuBarAccountColor: false,
    });

    manager.pushUpdate();

    expect(mockSendToHelper).toHaveBeenLastCalledWith(
      'tray.update',
      expect.objectContaining({ showMenuBarAccountColor: false }),
    );
  });

  it('colours an invitation by the calendar it sits on, not the account', () => {
    // An invitation the user accepted sits on their primary calendar, and that is the
    // colour Google paints it — not the organiser's calendar, and not the account's.
    manager.createTray();
    manager.updateAccounts([
      {
        id: 'acc_work',
        name: 'Work',
        color: '#3b82f6',
        partition: 'persist:magical_work',
        email: 'work@example.com',
        calendars: [{ id: 'work@example.com', name: 'Alex', color: '#039be5' }],
      },
    ]);

    manager.updateEvents(
      new Map([
        [
          'acc_work',
          [
            {
              id: 'their_standup',
              calendarIds: ['work@example.com'],
              summary: 'Their standup',
              startTime: new Date('2026-09-16T09:00:00Z'),
              endTime: new Date('2026-09-16T09:15:00Z'),
              isAllDay: false,
              myResponseStatus: 3,
              organizerEmail: 'organiser@example.com',
            } as NormalizedCalendarEvent,
          ],
        ],
      ]),
    );

    expect(mockSendToHelper).toHaveBeenLastCalledWith(
      'tray.update',
      expect.objectContaining({
        events: [expect.objectContaining({ id: 'their_standup', colorHex: '#039be5' })],
      }),
    );
  });

  it('falls back to the account colour only for a calendar nothing has ever named', () => {
    // The last resort, and the thing to watch: an account whose view has never been
    // scraped has no colour for any calendar, so every event takes the account's.
    manager.createTray();
    manager.updateAccounts([
      {
        id: 'acc_work',
        name: 'Work',
        color: '#3b82f6',
        partition: 'persist:magical_work',
        email: 'work@example.com',
      },
    ]);

    manager.updateEvents(
      new Map([
        [
          'acc_work',
          [
            {
              id: 'unknown_cal_event',
              calendarIds: ['never_seen@group.calendar.google.com'],
              summary: 'Their standup',
              startTime: new Date('2026-09-16T09:00:00Z'),
              endTime: new Date('2026-09-16T09:15:00Z'),
              isAllDay: false,
              myResponseStatus: 3,
            } as NormalizedCalendarEvent,
          ],
        ],
      ]),
    );

    expect(mockSendToHelper).toHaveBeenLastCalledWith(
      'tray.update',
      expect.objectContaining({
        events: [expect.objectContaining({ id: 'unknown_cal_event', colorHex: '#3b82f6' })],
      }),
    );
  });

  it('reports the calendar service\u2019s count, not its own reading of the cache', () => {
    // The service drops an invitation the moment it is answered from a banner; the cache
    // keeps `needsAction` until the next poll. Counting the cache here is how the popover
    // and the Dock badge came to disagree.
    mockCalendarService.pendingByAccount.mockReturnValue(new Map([['acc_work', 0]]));
    manager.createTray();
    manager.updateAccounts([
      {
        id: 'acc_work',
        name: 'Work',
        color: '#039be5',
        partition: 'persist:magical_work',
        email: 'work@example.com',
      },
    ]);

    const start = new Date('2026-09-16T14:00:00Z');
    manager.updateEvents(
      new Map([
        [
          'acc_work',
          [
            {
              id: 'stale_invite',
              calendarIds: ['work@example.com'],
              summary: 'Already answered',
              startTime: start,
              endTime: new Date('2026-09-16T15:00:00Z'),
              isAllDay: false,
              myResponseStatus: 0,
            } as NormalizedCalendarEvent,
          ],
        ],
      ]),
    );

    expect(mockSendToHelper).toHaveBeenLastCalledWith(
      'tray.update',
      expect.objectContaining({
        accounts: [expect.objectContaining({ id: 'acc_work', unreadCount: 0 })],
      }),
    );
  });

  it('handles tray.openQuickAdd and forwards accountId', () => {
    manager.handleEvent('tray.openQuickAdd', { accountId: 'acc_personal' });
    expect(mockOnNewEvent).toHaveBeenCalledWith('acc_personal');
  });

  it('handles tray.search by forwarding query and accountId to onSearch', () => {
    manager.handleEvent('tray.search', { query: 'standup', accountId: 'acc_work' });
    expect(mockOnSearch).toHaveBeenCalledWith('standup', 'acc_work');
  });

  it('ignores tray.search with an empty query', () => {
    manager.handleEvent('tray.search', { query: '', accountId: 'acc_work' });
    expect(mockOnSearch).not.toHaveBeenCalled();
  });

  it('handles tray.openSettings', () => {
    manager.handleEvent('tray.openSettings', {});
    expect(mockOnOpenSettings).toHaveBeenCalled();
  });

  it('handles tray.quit', () => {
    manager.handleEvent('tray.quit', {});
    expect(mockAppQuit).toHaveBeenCalled();
  });

  it('hands a call to the calendar service rather than opening it itself', () => {
    // The service is where `alwaysJoinInBrowser` is read. Rewriting the URL here instead
    // left the preference working on a notification banner and nowhere else.
    manager.handleEvent('tray.joinCall', { url: 'https://zoom.us/j/123456789' });

    expect(mockCalendarService.joinCall).toHaveBeenCalledWith('https://zoom.us/j/123456789');
    expect(mockShellOpenExternal).not.toHaveBeenCalled();
  });

  it('asks for the two months either side of the date the agenda scrolled to', () => {
    // The helper sends the date it needs; the 60 days around it are chosen here. The
    // service reads the request against the poll's own window and fetches only what falls
    // outside it, so asking for too little is what leaves the agenda ending in nothing.
    manager.handleEvent('tray.ensureRange', {
      targetDateMs: new Date('2027-06-15T12:00:00Z').getTime(),
    });

    const [start, end] = mockCalendarService.ensureRange.mock.lastCall as [Date, Date];
    const day = (d: Date) => d.toISOString().slice(0, 10);
    expect(day(start)).toBe('2027-04-16');
    expect(day(end)).toBe('2027-08-14');
  });

  it('ignores a range request carrying no usable date', () => {
    manager.handleEvent('tray.ensureRange', { targetDateMs: 'soon' });
    expect(mockCalendarService.ensureRange).not.toHaveBeenCalled();
  });

  it('drops an event whose timestamps are not a date, rather than pushing it', () => {
    // A tuple that decoded into a NaN or a year outside the calendar century would land
    // in the agenda as 1970 or 275760, and the mini-month's density dots with it.
    manager.createTray();
    manager.updateAccounts([
      {
        id: 'acc_work',
        name: 'Work',
        color: '#039be5',
        partition: 'persist:magical_work',
        email: 'work@example.com',
      },
    ]);

    const good = {
      id: 'good',
      calendarIds: ['work@example.com'],
      summary: 'Real meeting',
      startTime: new Date('2026-09-16T09:00:00Z'),
      endTime: new Date('2026-09-16T10:00:00Z'),
      isAllDay: false,
      myResponseStatus: 3,
    } as NormalizedCalendarEvent;

    manager.updateEvents(
      new Map([
        [
          'acc_work',
          [
            good,
            { ...good, id: 'nan', startTime: new Date('nonsense'), endTime: new Date('nonsense') },
            {
              ...good,
              id: 'before_1900',
              startTime: new Date('1823-04-01T09:00:00Z'),
              endTime: new Date('1823-04-01T10:00:00Z'),
            },
          ],
        ],
      ]),
    );

    expect(mockSendToHelper).toHaveBeenLastCalledWith(
      'tray.update',
      expect.objectContaining({ events: [expect.objectContaining({ id: 'good' })] }),
    );
  });

  it('persists the calendars hidden in the popover, each with its account', () => {
    manager.handleEvent('tray.setHiddenCalendars', {
      hiddenCalendars: [
        { accountId: 'acc_1', calendarId: 'cal_family' },
        { accountId: 'acc_1', calendarId: 'cal_holidays' },
      ],
    });

    expect(mockSaveSetting).toHaveBeenCalledWith('hiddenCalendars', [
      { accountId: 'acc_1', calendarId: 'cal_family' },
      { accountId: 'acc_1', calendarId: 'cal_holidays' },
    ]);
  });

  it('drops an entry that does not name both an account and a calendar', () => {
    manager.handleEvent('tray.setHiddenCalendars', {
      hiddenCalendars: [
        { accountId: 'acc_1', calendarId: 'cal_family' },
        { calendarId: 'cal_no_account' },
        42,
        null,
      ],
    });

    expect(mockSaveSetting).toHaveBeenCalledWith('hiddenCalendars', [
      { accountId: 'acc_1', calendarId: 'cal_family' },
    ]);
  });

  it('sends the hidden calendars back to the helper, so a restart keeps the filter', () => {
    mockLoadSettings.mockReturnValue({
      isCalendarCollapsed: false,
      menuBarDisplayMode: 'nextEvent',
      showMenuBarAccountColor: true,
      hiddenCalendars: [{ accountId: 'acc_1', calendarId: 'cal_family' }],
    });
    manager.createTray();

    expect(mockSendToHelper).toHaveBeenLastCalledWith(
      'tray.update',
      expect.objectContaining({
        hiddenCalendars: [{ accountId: 'acc_1', calendarId: 'cal_family' }],
      }),
    );
  });

  describe('two accounts that share a calendar id', () => {
    // Google serves `en.uk` and its replacement under different ids with identical events,
    // and gives Birthdays and Tasks the same id in every account, so a calendar id alone
    // never names one calendar.
    const HOLIDAYS = 'en-gb.uk#holiday@group.v.calendar.google.com';

    const setUp = (hidden: Array<{ accountId: string; calendarId: string }> = []) => {
      mockLoadSettings.mockReturnValue({
        isCalendarCollapsed: false,
        menuBarDisplayMode: 'nextEvent',
        showMenuBarAccountColor: true,
        hiddenCalendars: hidden,
      });
      manager.createTray();
      manager.updateAccounts([
        {
          id: 'acc_work',
          name: 'Work',
          color: '#3b82f6',
          partition: 'persist:magical_work',
          email: 'me@work.com',
          calendars: [
            { id: 'me@work.com', name: 'Me', color: '#039be5' },
            { id: HOLIDAYS, name: 'Holidays', color: '#0b8043' },
          ],
        },
        {
          id: 'acc_personal',
          name: 'Personal',
          color: '#22c55e',
          partition: 'persist:magical_personal',
          email: 'me@example.com',
          calendars: [
            { id: 'me@example.com', name: 'Me', color: '#039be5' },
            { id: HOLIDAYS, name: 'Holidays', color: '#0b8043' },
          ],
        },
      ]);
    };

    const lastTrayUpdate = () =>
      mockSendToHelper.mock.calls.filter(([method]) => method === 'tray.update').at(-1)?.[1] as {
        hiddenCalendars: Array<{ accountId: string; calendarId: string }>;
        calendars: Array<{ accountId: string; id: string }>;
        events: Array<{ accountId: string; id: string; deepLink?: string }>;
      };

    it('lists the calendar under each account, so the popover can toggle one', () => {
      setUp();

      expect(lastTrayUpdate().calendars.filter((c) => c.id === HOLIDAYS)).toEqual([
        expect.objectContaining({ accountId: 'acc_work', id: HOLIDAYS }),
        expect.objectContaining({ accountId: 'acc_personal', id: HOLIDAYS }),
      ]);
    });

    it('carries the account into the hidden set, so hiding one leaves the other', () => {
      setUp([{ accountId: 'acc_personal', calendarId: HOLIDAYS }]);

      const hidden = lastTrayUpdate().hiddenCalendars;
      expect(hidden).toContainEqual({ accountId: 'acc_personal', calendarId: HOLIDAYS });
      expect(hidden).not.toContainEqual({ accountId: 'acc_work', calendarId: HOLIDAYS });

      const widgetInput = mockBuildWidgetCache.mock.calls.at(-1)?.[0] as {
        hiddenCalendars: Array<{ accountId: string; calendarId: string }>;
      };
      expect(widgetInput.hiddenCalendars).toContainEqual({
        accountId: 'acc_personal',
        calendarId: HOLIDAYS,
      });
    });

    it('keeps each copy’s own link, so the reveal opens the right account’s chip', () => {
      setUp();
      // The two UK holiday feeds carry the same event ids. Each copy is decoded under its
      // own account and keeps that account's `eid`, so the reveal opens a chip Google
      // actually draws. Merging the copies by event id would send it to whichever account
      // the merge happened to keep.
      const dst = (eid: string): NormalizedCalendarEvent =>
        ({
          id: 'dst_20261025',
          calendarIds: [HOLIDAYS],
          summary: 'Daylight Saving Time ends',
          startTime: new Date('2026-10-25T00:00:00Z'),
          endTime: new Date('2026-10-26T00:00:00Z'),
          isAllDay: true,
          myResponseStatus: 3,
          webUrl: `https://www.google.com/calendar/event?eid=${eid}`,
        }) as NormalizedCalendarEvent;

      manager.updateEvents(
        new Map([
          ['acc_work', [dst('WORK_EID')]],
          ['acc_personal', [dst('PERSONAL_EID')]],
        ]),
      );

      const events = lastTrayUpdate().events;
      expect(events.find((e) => e.accountId === 'acc_personal')?.deepLink).toContain(
        `account=acc_personal&eid=${encodeURIComponent('PERSONAL_EID')}`,
      );
      expect(events.find((e) => e.accountId === 'acc_work')?.deepLink).toContain(
        `account=acc_work&eid=${encodeURIComponent('WORK_EID')}`,
      );
    });
  });

  it('drops events for an account that is no longer configured', () => {
    // Removing and re-adding one Google account issues a new id, so the old one's events
    // outlive every calendar row and cannot be hidden: the filter menu lists calendars,
    // and a calendar with no account has none to list.
    mockLoadSettings.mockReturnValue({
      isCalendarCollapsed: false,
      menuBarDisplayMode: 'nextEvent',
      showMenuBarAccountColor: true,
      hiddenCalendars: [],
    });
    manager.createTray();
    manager.updateAccounts([
      {
        id: 'acc_work',
        name: 'Work',
        color: '#3b82f6',
        partition: 'persist:work',
        email: 'me@work.com',
      },
    ]);
    manager.updateEvents(
      new Map([
        [
          'acc_gone',
          [
            {
              id: 'dst',
              calendarIds: ['en.uk#holiday@group.v.calendar.google.com'],
              summary: 'Daylight Saving Time ends',
              startTime: new Date('2026-10-25T00:00:00Z'),
              endTime: new Date('2026-10-26T00:00:00Z'),
              isAllDay: true,
              myResponseStatus: 3,
            } as NormalizedCalendarEvent,
          ],
        ],
      ]),
    );

    expect(mockSendToHelper).toHaveBeenLastCalledWith(
      'tray.update',
      expect.objectContaining({ events: [] }),
    );
  });

  it('handles tray.setCalendarCollapsed by persisting preference', () => {
    manager.handleEvent('tray.setCalendarCollapsed', { isCollapsed: true });
    expect(mockSaveSetting).toHaveBeenCalledWith('isCalendarCollapsed', true);
  });

  it('handles tray.rsvp by forwarding to calendarService', () => {
    for (const answer of ['yes', 'no', 'maybe'] as const) {
      manager.handleEvent('tray.rsvp', {
        accountId: 'acc_work',
        eventId: 'event_99',
        response: answer,
      });
      expect(mockCalendarService.answerRsvp).toHaveBeenLastCalledWith(
        'acc_work',
        'event_99',
        answer,
      );
    }
  });

  it('ignores an answer it does not recognise rather than guessing one', () => {
    // It used to default to yes, and a number meaning tentative elsewhere in the app meant
    // declined here. Answering the wrong thing on someone's behalf is worse than not
    // answering.
    manager.handleEvent('tray.rsvp', { accountId: 'acc_work', eventId: 'event_99', response: 2 });

    expect(mockCalendarService.answerRsvp).not.toHaveBeenCalled();
  });

  it('handles tray.deleteEvent by forwarding to calendarService', () => {
    manager.handleEvent('tray.deleteEvent', {
      accountId: 'acc_work',
      eventId: 'event_99',
    });
    expect(mockCalendarService.deleteEvent).toHaveBeenCalledWith('acc_work', 'event_99');
  });

  it('handles tray.setTaskCompleted by forwarding to calendarService', () => {
    manager.handleEvent('tray.setTaskCompleted', {
      accountId: 'acc_work',
      eventId: 'event_99',
      completed: true,
    });
    expect(mockCalendarService.setTaskCompleted).toHaveBeenCalledWith('acc_work', 'event_99', true);
  });

  it('forwards a reopen as completed false', () => {
    manager.handleEvent('tray.setTaskCompleted', {
      accountId: 'acc_work',
      eventId: 'event_99',
      completed: false,
    });
    expect(mockCalendarService.setTaskCompleted).toHaveBeenCalledWith(
      'acc_work',
      'event_99',
      false,
    );
  });

  it('treats a missing completed flag as a completion', () => {
    manager.handleEvent('tray.setTaskCompleted', {
      accountId: 'acc_work',
      eventId: 'event_99',
    });
    expect(mockCalendarService.setTaskCompleted).toHaveBeenCalledWith('acc_work', 'event_99', true);
  });

  it('handles tray.focusEvent by delegating to calendarService.openDeepLink', () => {
    const testEvent: NormalizedCalendarEvent = {
      id: 'event_focus',
      calendarIds: ['cal_work'],
      summary: 'Focus Me',
      webUrl: 'https://calendar.google.com/calendar/event?eid=ABC_FOCUS_123',
      startTime: new Date('2026-09-17T12:00:00Z'),
      endTime: new Date('2026-09-17T13:00:00Z'),
      isAllDay: false,
      myResponseStatus: 1,
    };
    manager.updateEvents(new Map([['acc_work', [testEvent]]]));

    manager.handleEvent('tray.focusEvent', {
      accountId: 'acc_work',
      eventId: 'event_focus',
    });

    expect(mockCalendarService.openDeepLink).toHaveBeenCalledWith(
      expect.stringContaining('magical://event?account=acc_work&eid=ABC_FOCUS_123'),
    );
    expect(mockWindow.show).toHaveBeenCalled();
    expect(mockWindow.focus).toHaveBeenCalled();
  });

  it('falls back to a day link when the event carries no resolvable eid', () => {
    manager.updateEvents(
      new Map([
        [
          'acc_work',
          [
            {
              id: 'event_no_eid',
              calendarIds: ['cal_work'],
              summary: 'No Link',
              startTime: new Date('2026-09-17T12:00:00Z'),
              endTime: new Date('2026-09-17T13:00:00Z'),
              isAllDay: false,
              myResponseStatus: 1,
            } as NormalizedCalendarEvent,
          ],
        ],
      ]),
    );

    manager.handleEvent('tray.focusEvent', { accountId: 'acc_work', eventId: 'event_no_eid' });

    expect(mockCalendarService.openDeepLink).toHaveBeenCalledWith(
      'magical://date?account=acc_work&at=2026-09-17T12%3A00%3A00.000Z',
    );
  });

  it('shows the account rather than nothing when the event is not cached', () => {
    manager.handleEvent('tray.focusEvent', { accountId: 'acc_work', eventId: 'missing' });

    expect(mockCalendarService.openDeepLink).not.toHaveBeenCalled();
    expect(mockAccountsManager.switchAccount).toHaveBeenCalledWith('acc_work');
    expect(mockWindow.show).toHaveBeenCalled();
  });

  describe('an event held by several calendars', () => {
    const RECRUITING = 'recruiting@group.calendar.google.com';

    const setUp = (calendarIds: string[]) => {
      mockLoadSettings.mockReturnValue({
        isCalendarCollapsed: false,
        menuBarDisplayMode: 'nextEvent',
        showMenuBarAccountColor: true,
        hiddenCalendars: [{ accountId: 'acc_work', calendarId: RECRUITING }],
      });
      manager.createTray();
      manager.updateAccounts([
        {
          id: 'acc_work',
          name: 'Work',
          color: '#3b82f6',
          partition: 'persist:magical_work',
          email: 'me@work.com',
          calendars: [
            { id: 'me@work.com', name: 'Alex', color: '#039be5' },
            { id: RECRUITING, name: 'Recruiting', color: '#f4511e' },
          ],
        },
      ]);
      manager.updateEvents(
        new Map([
          [
            'acc_work',
            [
              {
                id: 'team_sync',
                calendarIds,
                summary: 'Team Sync',
                startTime: new Date('2026-09-16T13:30:00Z'),
                endTime: new Date('2026-09-16T14:30:00Z'),
                isAllDay: false,
                myResponseStatus: 3,
              } as NormalizedCalendarEvent,
            ],
          ],
        ]),
      );
    };

    /** What the widget snapshot was built from. */
    const widgetInput = () =>
      mockBuildWidgetCache.mock.calls.at(-1)?.[0] as {
        events: Array<{ id: string; calendarIds: string[] }>;
        hiddenCalendars: Array<{ accountId: string; calendarId: string }>;
      };

    it('hands the widgets every event, hidden calendars and all', () => {
      // Each widget carries its own choice of calendars, which only the extension can
      // read, so a snapshot filtered here would decide for it.
      setUp([RECRUITING]);
      expect(widgetInput().events.map((e) => e.id)).toEqual(['team_sync']);
    });

    it('hands the widgets the popover filter, for a widget that has never been configured', () => {
      setUp([RECRUITING]);
      expect(widgetInput().hiddenCalendars).toEqual([
        { accountId: 'acc_work', calendarId: RECRUITING },
      ]);
    });

    it('draws it as a calendar the user can still see', () => {
      // Painting it in the hidden calendar's colour names a calendar they have just taken
      // out of their day.
      setUp([RECRUITING, 'me@work.com']);
      expect(mockSendToHelper).toHaveBeenLastCalledWith(
        'tray.update',
        expect.objectContaining({
          events: [
            expect.objectContaining({
              id: 'team_sync',
              colorHex: '#039be5',
              calendarName: 'Alex',
              calendarIds: [RECRUITING, 'me@work.com'],
            }),
          ],
        }),
      );
    });

    it('leaves the popover to do its own filtering, and sends every calendar', () => {
      // The popover holds the user's live filter, which a toggle has not yet persisted
      // back here, so it needs the whole list rather than a verdict.
      setUp([RECRUITING]);
      expect(mockSendToHelper).toHaveBeenLastCalledWith(
        'tray.update',
        expect.objectContaining({
          events: [expect.objectContaining({ id: 'team_sync', calendarIds: [RECRUITING] })],
        }),
      );
    });
  });

  describe('health', () => {
    const account = (id: string): CalendarAccount => ({
      id,
      name: id,
      color: '#039be5',
      partition: `persist:magical_${id}`,
      email: `${id}@example.com`,
    });

    const lastUpdate = () =>
      mockSendToHelper.mock.calls.filter((c) => c[0] === 'tray.update').at(-1)?.[1] as {
        isOffline: boolean;
        isRestricted: boolean;
        lastSyncedAt?: number;
        accounts: { id: string; needsAuth: boolean }[];
      };

    beforeEach(() => {
      manager.createTray();
      manager.updateAccounts([account('acc_work'), account('acc_home')]);
    });

    it('calls the popover offline only when no account can reach the network', () => {
      manager.setAccountHealth('acc_work', 'offline');
      expect(lastUpdate().isOffline).toBe(false);

      manager.setAccountHealth('acc_home', 'offline');
      expect(lastUpdate().isOffline).toBe(true);

      // One account reading again is enough: its agenda is live, so a band across the
      // whole popover saying the network is gone would be false for what is on screen.
      manager.setAccountHealth('acc_work', 'ok');
      expect(lastUpdate().isOffline).toBe(false);
    });

    it('surfaces a tenant policy refusal as restricted, not offline or sign-in', () => {
      manager.setAccountHealth('acc_work', 'restricted');
      manager.setAccountHealth('acc_home', 'ok');

      expect(lastUpdate().isRestricted).toBe(true);
      expect(lastUpdate().isOffline).toBe(false);
      // A policy block is not something the user can sign their way out of.
      expect(lastUpdate().accounts.map((a) => a.needsAuth)).toEqual([false, false]);
    });

    it('does not call a moved wire format offline', () => {
      manager.setAccountHealth('acc_work', 'unreadable');
      manager.setAccountHealth('acc_home', 'unreadable');

      // Google answered, so the network is fine and the app is what is broken. Telling
      // the user to check their connection sends them after the wrong problem.
      expect(lastUpdate().isOffline).toBe(false);
    });

    it('treats a signed-out account as needing auth rather than as offline', () => {
      manager.setAccountHealth('acc_work', 'signed-out');
      manager.setAccountHealth('acc_home', 'signed-out');

      expect(lastUpdate().isOffline).toBe(false);
      expect(lastUpdate().accounts.map((a) => a.needsAuth)).toEqual([true, true]);
    });

    it('marks only the account whose session expired', () => {
      manager.setAccountHealth('acc_work', 'signed-out');
      manager.setAccountHealth('acc_home', 'ok');

      expect(lastUpdate().accounts).toEqual([
        expect.objectContaining({ id: 'acc_work', needsAuth: true }),
        expect.objectContaining({ id: 'acc_home', needsAuth: false }),
      ]);
    });

    it('is not offline before any account has reported', () => {
      expect(lastUpdate().isOffline).toBe(false);
    });

    it('reports the oldest read among the accounts that have stopped reading', () => {
      const older = new Date('2026-03-01T09:00:00Z');
      const newer = new Date('2026-03-01T09:30:00Z');

      manager.setAccountHealth('acc_work', 'stale', older);
      manager.setAccountHealth('acc_home', 'stale', newer);

      // The worst case, not an average nothing actually experienced.
      expect(lastUpdate().lastSyncedAt).toBe(older.getTime());
    });

    it('leaves an account that is reading normally out of the age', () => {
      const stalled = new Date('2026-03-01T09:00:00Z');

      manager.setAccountHealth('acc_home', 'ok', new Date('2026-03-01T11:00:00Z'));
      manager.setAccountHealth('acc_work', 'stale', stalled);

      expect(lastUpdate().lastSyncedAt).toBe(stalled.getTime());
    });

    it('withdraws the age once everything is reading again', () => {
      manager.setAccountHealth('acc_work', 'stale', new Date('2026-03-01T09:00:00Z'));
      expect(lastUpdate().lastSyncedAt).toBeDefined();

      manager.setAccountHealth('acc_work', 'ok', new Date('2026-03-01T11:00:00Z'));
      manager.setAccountHealth('acc_home', 'ok', new Date('2026-03-01T11:00:00Z'));

      // Absent rather than stale: "last synced two hours ago" left over a live agenda is
      // the same class of lie the banner exists to prevent.
      expect(lastUpdate().lastSyncedAt).toBeUndefined();
    });

    it('forgets a removed account rather than staying offline for it', () => {
      manager.setAccountHealth('acc_work', 'offline');
      manager.setAccountHealth('acc_home', 'offline');
      expect(lastUpdate().isOffline).toBe(true);

      // Removed, then added back: the account has read nothing since, so its old failure
      // must not be one of the two that hold the popover offline.
      manager.updateAccounts([account('acc_work')]);
      manager.updateAccounts([account('acc_work'), account('acc_home')]);

      expect(lastUpdate().isOffline).toBe(false);
    });

    it('pushes nothing when an account reports the same health twice', () => {
      manager.setAccountHealth('acc_work', 'ok');
      const before = mockSendToHelper.mock.calls.length;
      manager.setAccountHealth('acc_work', 'ok');

      expect(mockSendToHelper.mock.calls.length).toBe(before);
    });
  });

  describe('task completion handling', () => {
    const taskEvent: NormalizedCalendarEvent = {
      id: 'task_1',
      calendarIds: ['tasks@tasks.google.com'],
      summary: 'Review design doc',
      startTime: new Date('2026-09-17T10:00:00Z'),
      endTime: new Date('2026-09-17T11:00:00Z'),
      isAllDay: false,
      eventType: 7, // TASK
      isCompleted: true,
      myResponseStatus: 'notInvited',
    };

    it('serializes isCompleted and passes showCompletedTasks to helper', () => {
      mockLoadSettings.mockReturnValue({
        isCalendarCollapsed: false,
        menuBarDisplayMode: 'nextEvent',
        showMenuBarAccountColor: true,
        hiddenCalendars: [],
        showCompletedTasks: true,
      });

      manager.createTray();
      manager.updateAccounts([
        {
          id: 'acc_work',
          name: 'Work',
          color: '#039be5',
          partition: 'persist:work',
          email: 'work@example.com',
        },
      ]);
      manager.updateEvents(new Map([['acc_work', [taskEvent]]]));

      expect(mockSendToHelper).toHaveBeenLastCalledWith(
        'tray.update',
        expect.objectContaining({
          showCompletedTasks: true,
          events: [
            expect.objectContaining({
              id: 'task_1',
              isCompleted: true,
            }),
          ],
        }),
      );
    });

    it('filters out completed tasks from widgets when showCompletedTasks is false', () => {
      mockLoadSettings.mockReturnValue({
        isCalendarCollapsed: false,
        menuBarDisplayMode: 'nextEvent',
        showMenuBarAccountColor: true,
        hiddenCalendars: [],
        showCompletedTasks: false,
      });

      manager.createTray();
      manager.updateAccounts([
        {
          id: 'acc_work',
          name: 'Work',
          color: '#039be5',
          partition: 'persist:work',
          email: 'work@example.com',
        },
      ]);
      manager.updateEvents(new Map([['acc_work', [taskEvent]]]));

      expect(mockBuildWidgetCache).toHaveBeenLastCalledWith(
        expect.objectContaining({
          events: [],
          activeAccountId: 'acc_work',
        }),
      );
    });

    it('retains completed tasks in widgets when showCompletedTasks is true', () => {
      mockLoadSettings.mockReturnValue({
        isCalendarCollapsed: false,
        menuBarDisplayMode: 'nextEvent',
        showMenuBarAccountColor: true,
        hiddenCalendars: [],
        showCompletedTasks: true,
      });

      manager.createTray();
      manager.updateAccounts([
        {
          id: 'acc_work',
          name: 'Work',
          color: '#039be5',
          partition: 'persist:work',
          email: 'work@example.com',
        },
      ]);
      manager.updateEvents(new Map([['acc_work', [taskEvent]]]));

      expect(mockBuildWidgetCache).toHaveBeenLastCalledWith(
        expect.objectContaining({
          events: [expect.objectContaining({ id: 'task_1', isCompleted: true })],
          activeAccountId: 'acc_work',
        }),
      );
    });

    it('persists setting and pushes update on tray.setShowCompletedTasks event', () => {
      manager.createTray();
      const handled = manager.handleEvent('tray.setShowCompletedTasks', {
        showCompletedTasks: true,
      });

      expect(handled).toBe(true);
      expect(mockSaveSetting).toHaveBeenCalledWith('showCompletedTasks', true);
      expect(mockSendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('tray date window and push deduplication', () => {
    it('omits events falling outside the default -30d..+60d window', () => {
      manager.createTray();
      manager.updateAccounts([
        {
          id: 'acc_work',
          name: 'Work',
          color: '#039be5',
          partition: 'persist:work',
          email: 'work@example.com',
        },
      ]);

      const nearEvent: NormalizedCalendarEvent = {
        id: 'near',
        calendarIds: ['work@example.com'],
        summary: 'Tomorrow Meeting',
        created: null,
        updated: null,
        startTime: new Date('2026-09-17T10:00:00Z'),
        endTime: new Date('2026-09-17T11:00:00Z'),
        isAllDay: false,
        eventType: 0,
        attendees: [],
        myResponseStatus: 1,
        reminders: [],
      };

      const distantPastEvent: NormalizedCalendarEvent = {
        id: 'distant_past',
        calendarIds: ['work@example.com'],
        summary: 'Old Meeting',
        created: null,
        updated: null,
        startTime: new Date('2026-07-01T10:00:00Z'),
        endTime: new Date('2026-07-01T11:00:00Z'),
        isAllDay: false,
        eventType: 0,
        attendees: [],
        myResponseStatus: 1,
        reminders: [],
      };

      const distantFutureEvent: NormalizedCalendarEvent = {
        id: 'distant_future',
        calendarIds: ['work@example.com'],
        summary: 'Next Year Meeting',
        created: null,
        updated: null,
        startTime: new Date('2027-01-01T10:00:00Z'),
        endTime: new Date('2027-01-01T11:00:00Z'),
        isAllDay: false,
        eventType: 0,
        attendees: [],
        myResponseStatus: 1,
        reminders: [],
      };

      manager.updateEvents(
        new Map([['acc_work', [nearEvent, distantPastEvent, distantFutureEvent]]]),
      );

      const last = mockSendToHelper.mock.calls
        .filter(([m]) => m === 'tray.update')
        .pop()?.[1] as any;
      const ids = last.events.map((e: any) => e.id);
      expect(ids).toContain('near');
      expect(ids).not.toContain('distant_past');
      expect(ids).not.toContain('distant_future');
    });

    it('widens the date window and pushes when tray.ensureRange is received', () => {
      manager.createTray();
      manager.updateAccounts([
        {
          id: 'acc_work',
          name: 'Work',
          color: '#039be5',
          partition: 'persist:work',
          email: 'work@example.com',
        },
      ]);

      const distantEvent: NormalizedCalendarEvent = {
        id: 'distant_future',
        calendarIds: ['work@example.com'],
        summary: 'Future Meeting',
        created: null,
        updated: null,
        startTime: new Date('2027-01-01T10:00:00Z'),
        endTime: new Date('2027-01-01T11:00:00Z'),
        isAllDay: false,
        eventType: 0,
        attendees: [],
        myResponseStatus: 1,
        reminders: [],
      };

      manager.updateEvents(new Map([['acc_work', [distantEvent]]]));
      let last = mockSendToHelper.mock.calls.filter(([m]) => m === 'tray.update').pop()?.[1] as any;
      expect(last.events).toHaveLength(0);

      // ensureRange for target date in 2027
      manager.handleEvent('tray.ensureRange', {
        targetDateMs: new Date('2027-01-01T10:00:00Z').getTime(),
      });

      last = mockSendToHelper.mock.calls.filter(([m]) => m === 'tray.update').pop()?.[1] as any;
      expect(last.events.map((e: any) => e.id)).toContain('distant_future');
    });

    it('does not dispatch a second tray.update when the payload is identical', () => {
      manager.createTray();
      const callsBefore = mockSendToHelper.mock.calls.filter(([m]) => m === 'tray.update').length;

      // Pushing again without changes should be dropped
      manager.pushUpdate();
      const callsAfter = mockSendToHelper.mock.calls.filter(([m]) => m === 'tray.update').length;
      expect(callsAfter).toBe(callsBefore);
    });

    it('re-sends the payload on the next tick if the helper RPC times out or fails', async () => {
      // tray.create succeeds ('ok'), tray.update fails (null)
      mockSendToHelper.mockResolvedValueOnce('ok').mockResolvedValueOnce(null);
      manager.createTray();
      await vi.waitFor(() => {
        expect(mockSendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));
      });

      const callsAfterFirst = mockSendToHelper.mock.calls.filter(
        ([m]) => m === 'tray.update',
      ).length;

      // Pushing on next tick without any data changes should NOT be dropped because the prior delivery failed
      manager.pushUpdate();
      const callsAfterTick = mockSendToHelper.mock.calls.filter(
        ([m]) => m === 'tray.update',
      ).length;
      expect(callsAfterTick).toBe(callsAfterFirst + 1);
    });

    it('schedules a retry after a dropped tray.update payload', async () => {
      mockSendToHelper.mockResolvedValueOnce('ok').mockResolvedValueOnce(null);
      manager.createTray();

      await vi.waitFor(() => {
        expect(mockSendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));
      });

      const callsBeforeRetry = mockSendToHelper.mock.calls.filter(
        ([m]) => m === 'tray.update',
      ).length;

      // Fast-forward the retry delay (1000ms)
      mockSendToHelper.mockResolvedValueOnce('ok');
      await vi.advanceTimersByTimeAsync(1000);

      const callsAfterRetry = mockSendToHelper.mock.calls.filter(
        ([m]) => m === 'tray.update',
      ).length;
      expect(callsAfterRetry).toBe(callsBeforeRetry + 1);
    });

    it('does not retry infinitely if the retry also fails', async () => {
      // Create succeeds, but all tray.update fail
      mockSendToHelper.mockImplementation((method) =>
        method === 'tray.create' ? Promise.resolve('ok') : Promise.resolve(null),
      );
      manager.createTray();

      await vi.waitFor(() => {
        expect(mockSendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));
      });

      // Advance timers for the 1 retry
      await vi.advanceTimersByTimeAsync(1000);
      const callsAfterFirstRetry = mockSendToHelper.mock.calls.filter(
        ([m]) => m === 'tray.update',
      ).length;

      // Advance timers further - should not trigger another retry
      await vi.advanceTimersByTimeAsync(5000);
      const callsLater = mockSendToHelper.mock.calls.filter(([m]) => m === 'tray.update').length;
      expect(callsLater).toBe(callsAfterFirstRetry);
    });

    it('restores the tray and re-sends the payload on restoreTray', () => {
      manager.createTray();
      mockSendToHelper.mockClear();

      manager.restoreTray();

      expect(mockSendToHelper).toHaveBeenCalledWith('tray.create');
      expect(mockSendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));
    });
  });
});
