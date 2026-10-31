import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SidebarManager } from '../src/sidebar-manager.js';
import type { CalendarAccount } from '../src/accounts.js';
import type { NormalizedCalendarEvent } from '../src/calendar-decoder.js';

const mockLoadAddon = vi.fn();
const mockSaveSetting = vi.fn();
const mockLoadSettings = vi.fn().mockReturnValue({
  sidebarVisible: true,
  sidebarPosition: 'right',
  isCalendarCollapsed: false,
});
const mockOpenExternal = vi.fn();

vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => mockOpenExternal(url),
  },
}));

vi.mock('../src/native-addon.js', () => ({
  loadAddon: () => mockLoadAddon(),
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: () => mockLoadSettings(),
  saveSetting: (...args: unknown[]) => mockSaveSetting(...args),
}));

describe('SidebarManager', () => {
  let sidebarAttach: ReturnType<typeof vi.fn>;
  let sidebarSetVisible: ReturnType<typeof vi.fn>;
  let sidebarSetViewMode: ReturnType<typeof vi.fn>;
  let sidebarUpdateData: ReturnType<typeof vi.fn>;
  let mockMainWindow: { getNativeWindowHandle: ReturnType<typeof vi.fn> };
  let mockAccountsManager: {
    updateLayout: ReturnType<typeof vi.fn>;
    navigateToDate: ReturnType<typeof vi.fn>;
    revealEvent: ReturnType<typeof vi.fn>;
    getActiveAccountId: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    sidebarAttach = vi.fn();
    sidebarSetVisible = vi.fn();
    sidebarSetViewMode = vi.fn();
    sidebarUpdateData = vi.fn();

    mockLoadAddon.mockReturnValue({
      sidebarAttach,
      sidebarSetVisible,
      sidebarSetViewMode,
      sidebarUpdateData,
    });

    mockMainWindow = {
      getNativeWindowHandle: vi.fn().mockReturnValue(Buffer.from('handle')),
    };

    mockAccountsManager = {
      updateLayout: vi.fn(),
      navigateToDate: vi.fn().mockResolvedValue(true),
      revealEvent: vi.fn().mockResolvedValue('revealed'),
      getActiveAccountId: vi.fn().mockReturnValue('acc_personal'),
    };
  });

  it('attaches to native window and pushes initial mode', () => {
    const manager = new SidebarManager(
      () => mockMainWindow as any,
      () => mockAccountsManager as any,
    );

    manager.attach(mockMainWindow as any);

    expect(sidebarAttach).toHaveBeenCalledWith(Buffer.from('handle'));
    expect(sidebarSetVisible).toHaveBeenCalledWith(true, false);
    expect(sidebarSetViewMode).toHaveBeenCalledWith('month', undefined);
  });

  it('toggles sidebar visibility, saves setting, and triggers layout update', () => {
    const manager = new SidebarManager(
      () => mockMainWindow as any,
      () => mockAccountsManager as any,
    );

    manager.toggleSidebar();

    expect(mockSaveSetting).toHaveBeenCalledWith('sidebarVisible', false);
    expect(sidebarSetVisible).toHaveBeenCalledWith(false, true);
    expect(mockAccountsManager.updateLayout).toHaveBeenCalled();

    manager.toggleSidebar();
    expect(mockSaveSetting).toHaveBeenCalledWith('sidebarVisible', true);
    expect(sidebarSetVisible).toHaveBeenCalledWith(true, true);
  });

  it('relays timeframe and anchor date changes to native addon', () => {
    const manager = new SidebarManager(
      () => mockMainWindow as any,
      () => mockAccountsManager as any,
    );

    manager.setTimeframe('week', '2026-10-14');
    expect(sidebarSetViewMode).toHaveBeenCalledWith('week', '2026-10-14');

    manager.setTimeframe('day', '2026-10-15');
    expect(sidebarSetViewMode).toHaveBeenCalledWith('day', '2026-10-15');
  });

  it('serializes events and accounts and pushes to native addon', () => {
    const manager = new SidebarManager(
      () => mockMainWindow as any,
      () => mockAccountsManager as any,
    );

    const accounts: CalendarAccount[] = [
      {
        id: 'acc_personal',
        name: 'Personal',
        email: 'person@example.com',
        color: '#4285f4',
        calendarIds: ['person@example.com'],
      },
    ];

    const events = new Map<string, NormalizedCalendarEvent[]>([
      [
        'acc_personal',
        [
          {
            id: 'evt_1',
            summary: 'Team Standup',
            startTime: new Date('2026-10-14T09:00:00Z'),
            endTime: new Date('2026-10-14T09:30:00Z'),
            isAllDay: false,
            calendarIds: ['person@example.com'],
            attendees: [],
            eventType: 0,
            webUrl: 'https://calendar.google.com/event?eid=123',
            created: null,
            updated: null,
            conferenceUrl: 'https://meet.google.com/abc-defg-hij',
          },
        ],
      ],
    ]);

    manager.updateAccounts(accounts);
    manager.updateEvents(events);

    expect(sidebarUpdateData).toHaveBeenCalled();
    const lastCallJson = JSON.parse(sidebarUpdateData.mock.calls.at(-1)![0]);
    expect(lastCallJson.accounts).toHaveLength(1);
    expect(lastCallJson.events).toHaveLength(1);
    expect(lastCallJson.events[0].summary).toBe('Team Standup');
    expect(lastCallJson.events[0].conferenceUrl).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('handles sidebar actions: date selection, event open, and join call', () => {
    const manager = new SidebarManager(
      () => mockMainWindow as any,
      () => mockAccountsManager as any,
    );

    // 1. Date select
    manager.handleSidebarAction('sidebarSelectDate', '2026-10-14');
    expect(mockAccountsManager.navigateToDate).toHaveBeenCalledWith(new Date(2026, 9, 14));

    // 2. Open event
    const events = new Map<string, NormalizedCalendarEvent[]>([
      [
        'acc_personal',
        [
          {
            id: 'evt_special',
            summary: 'Key Meeting',
            startTime: new Date('2026-10-14T10:00:00Z'),
            endTime: new Date('2026-10-14T11:00:00Z'),
            isAllDay: false,
            calendarIds: ['person@example.com'],
            attendees: [],
            eventType: 0,
            webUrl: 'https://calendar.google.com/event?eid=special',
            created: null,
            updated: null,
          },
        ],
      ],
    ]);
    manager.updateEvents(events);
    manager.handleSidebarAction('sidebarOpenEvent', 'evt_special');
    expect(mockAccountsManager.revealEvent).toHaveBeenCalledWith(
      'acc_personal',
      'evt_special',
      expect.any(Date),
    );

    // 3. Join call
    manager.handleSidebarAction('sidebarJoinCall', 'https://meet.google.com/xyz-uvw-rst');
    expect(mockOpenExternal).toHaveBeenCalledWith('https://meet.google.com/xyz-uvw-rst');
  });
});
