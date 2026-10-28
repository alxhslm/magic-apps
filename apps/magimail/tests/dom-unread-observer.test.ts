import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { BaseWindow } from 'electron';
import { AccountsManager } from '../src/accounts-manager.js';
import { AtomFeedPoller, type NotificationCategory } from '../src/atom-poller.js';

const TEST_USER_DATA = vi.hoisted(
  () => `/tmp/magimail-dom-unread-test-${process.pid}-${Date.now()}`,
);

vi.mock('../src/native-toolbar.js', () => ({
  attachNativeToolbar: vi.fn(),
  updateNativeToolbarAccounts: vi.fn(),
  setNativeToolbarItemEnabled: vi.fn(),
  setNativeToolbarShareUrl: vi.fn(),
  showNativeSharingPicker: vi.fn(),
}));

vi.mock('../src/dock.js', () => ({
  updateDockBadge: vi.fn(),
  getCurrentBadgeCount: vi.fn().mockReturnValue(0),
}));

vi.mock('@magimail/core', async () => {
  const actual = await vi.importActual<typeof import('@magimail/core')>('@magimail/core');
  return {
    ...actual,
    configureGoogleSession: vi.fn(),
    injectGmailStyles: vi.fn().mockResolvedValue(undefined),
  };
});

const mockChildren: unknown[] = [];
const mockContentView = {
  children: mockChildren,
  addChildView: vi.fn((view: unknown) => {
    mockChildren.push(view);
  }),
  removeChildView: vi.fn((view: unknown) => {
    const idx = mockChildren.indexOf(view);
    if (idx >= 0) mockChildren.splice(idx, 1);
  }),
};

vi.mock('electron', () => {
  const mockWebContents = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
    isLoading: vi.fn().mockReturnValue(false),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue(''),
    isDestroyed: vi.fn().mockReturnValue(false),
    executeJavaScript: vi.fn().mockResolvedValue(false),
    getURL: vi.fn().mockReturnValue('https://mail.google.com/mail/u/0/#inbox'),
    mainFrame: { frames: [] },
  };

  class MockWebContentsView {
    webContents = { ...mockWebContents };
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();
  }

  class MockBaseWindow {
    contentView = mockContentView;
    on = vi.fn();
    isDestroyed = vi.fn().mockReturnValue(false);
    isFocused = vi.fn().mockReturnValue(true);
    isMinimized = vi.fn().mockReturnValue(false);
    isVisible = vi.fn().mockReturnValue(true);
    getBounds = vi.fn().mockReturnValue({ width: 1000, height: 800 });
    getContentSize = vi.fn().mockReturnValue([1000, 800]);
    setBackgroundColor = vi.fn();
  }

  return {
    app: {
      getPath: vi.fn().mockReturnValue(TEST_USER_DATA),
      isPackaged: false,
    },
    BaseWindow: MockBaseWindow,
    WebContentsView: MockWebContentsView,
    webFrameMain: { fromId: vi.fn() },
    session: { fromPartition: vi.fn() },
    powerMonitor: {
      isOnBatteryPower: vi.fn().mockReturnValue(false),
      on: vi.fn(),
    },
  };
});

const mockCurrentSettings = {
  inactiveAccountSuspendMinutes: 0,
  transparentBackground: false,
  dismissedApiPrompts: [] as string[],
  notifications: {
    primary: 'loud',
    updates: 'silent',
    social: 'badge',
    promotions: 'off',
    forums: 'off',
  },
};

vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn(() => ({ ...mockCurrentSettings })),
  saveSetting: vi.fn((key: string, value: unknown) => {
    (mockCurrentSettings as Record<string, unknown>)[key] = value;
    return { ...mockCurrentSettings };
  }),
}));

describe('DOM unread observation and adaptive polling', () => {
  let mainWindow: BaseWindow;
  let accountsManager: AccountsManager;

  beforeEach(() => {
    mockChildren.length = 0;
    mockCurrentSettings.dismissedApiPrompts = [];
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    const accountsData = [
      {
        id: 'account_personal',
        name: 'Personal',
        email: 'test@example.com',
        color: '#4285f4',
        partition: 'persist:magimail_personal',
        unreadCount: 0,
      },
    ];
    fs.writeFileSync(`${TEST_USER_DATA}/accounts.json`, JSON.stringify(accountsData));

    mainWindow = new BaseWindow();
    accountsManager = new AccountsManager(mainWindow, '/mock/preload.js');
    accountsManager.bannerSettleDelayMs = 0;
    accountsManager.initialize();
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error if already removed
    }
  });

  it('calculates effective unread from local cache with category filtering', () => {
    const onUnreadChanged = vi.fn();
    accountsManager.onUnreadChanged = onUnreadChanged;

    // Cache reports: primary 1, social 5, updates 2, promotions 10 (off in settings)
    const cacheCounts = new Map<NotificationCategory, number>([
      ['primary', 1],
      ['social', 5],
      ['updates', 2],
      ['promotions', 10],
      ['forums', 0],
    ]);
    accountsManager.handleCacheCategoryCounts('account_personal', cacheCounts);

    // Effective: Primary (1) + Social (5) + Updates (2) = 8
    // Promotions (10) is excluded because notifications.promotions is 'off'
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(8);
  });

  it('prevents stale Atom poll from clobbering active cache unread count (anti-bounce)', () => {
    // 1. User archives email -> cache updates instantly to 3
    accountsManager.handleCacheCategoryCounts(
      'account_personal',
      new Map<NotificationCategory, number>([
        ['primary', 3],
        ['updates', 0],
        ['social', 0],
        ['promotions', 0],
        ['forums', 0],
      ]),
    );
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(3);

    // 2. Stale Atom poll arrives 500ms later reporting old count of 4
    const atomCategoryCounts = new Map<NotificationCategory, number>([['primary', 4]]);
    accountsManager.handleApiUnreadUpdate('account_personal', 4, atomCategoryCounts);

    // The active account's effective unread MUST remain 3, not revert to 4!
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(3);
    const acc = accountsManager.getAccounts().find((a) => a.id === 'account_personal');
    expect(acc?.unreadCount).toBe(3);
  });

  it('accelerates AtomFeedPoller interval to 5s when window is focused', () => {
    const onPoll = vi.fn();
    const poller = new AtomFeedPoller(
      'account_personal',
      'persist:magimail_personal',
      60,
      120,
      onPoll,
    );

    // Baseline: 60s AC / 120s battery
    expect(poller.getEffectiveInterval()).toBe(60000);

    // When focused: 5s on AC
    poller.setFocusAndMissingCategories(true, ['updates']);
    expect(poller.getEffectiveInterval()).toBe(5000);

    // When window loses focus: reverts to 60s
    poller.setFocusAndMissingCategories(false, ['updates']);
    expect(poller.getEffectiveInterval()).toBe(60000);
  });

  it('does not prompt for missing categories or show category banner now that cache supplies category counts', () => {
    // 1. Initially no banner is shown before any scan
    expect(accountsManager.isCategoryBannerShowing()).toBe(false);

    // 2. DOM report without updates or social in sidebar
    accountsManager.handleDomUnreadUpdate('account_personal', {
      timestamp: Date.now(),
      counts: { inbox: 2 },
      presentCategories: ['inbox'],
      isLoaded: true,
    });

    // Banner is NOT shown because local cache supplies category counts
    expect(accountsManager.isCategoryBannerShowing()).toBe(false);
    expect(accountsManager.getMissingCategoriesForAccount('account_personal')).toEqual([]);
  });

  it('manages native category banner dismissal methods safely', () => {
    expect(accountsManager.isCategoryBannerShowing()).toBe(false);
    accountsManager.dismissCategoryBanner('account_personal');
    expect(accountsManager.isCategoryBannerDismissed('account_personal')).toBe(true);
    expect(accountsManager.isCategoryBannerShowing()).toBe(false);

    // Ensure it was NOT written to settings.json
    expect(mockCurrentSettings.dismissedApiPrompts).not.toContain(
      'account_personal_category_banner',
    );
  });

  it('shows offline mail banner and prompts for Atom polling when offline cache is absent', () => {
    const onAbsent = vi.fn();
    accountsManager.onAbsentCategoriesChanged = onAbsent;

    expect(accountsManager.isCategoryBannerShowing()).toBe(false);

    accountsManager.handleOfflineCacheStatus('account_personal', false);

    expect(accountsManager.isCategoryBannerShowing()).toBe(true);
    expect(accountsManager.isOfflineCacheAvailable('account_personal')).toBe(false);
    expect(onAbsent).toHaveBeenCalledWith('account_personal', ['updates', 'social']);

    // Dismissing banner hides it
    accountsManager.dismissCategoryBanner('account_personal');
    expect(accountsManager.isCategoryBannerShowing()).toBe(false);

    // If cache becomes available later, status updates and banner stays hidden
    accountsManager.handleOfflineCacheStatus('account_personal', true);
    expect(accountsManager.isOfflineCacheAvailable('account_personal')).toBe(true);
    expect(accountsManager.isCategoryBannerShowing()).toBe(false);
  });

  it('hides offline mail banner when cache status transitions to true', () => {
    expect(accountsManager.isCategoryBannerShowing()).toBe(false);

    accountsManager.handleOfflineCacheStatus('account_personal', false);
    expect(accountsManager.isCategoryBannerShowing()).toBe(true);

    accountsManager.handleOfflineCacheStatus('account_personal', true);
    expect(accountsManager.isCategoryBannerShowing()).toBe(false);
  });

  it('cleans up legacy category banner keys from settings on initialize', () => {
    mockCurrentSettings.dismissedApiPrompts = ['account_personal_category_banner', 'other_prompt'];
    const newMgr = new AccountsManager(mainWindow, '/mock/preload.js');
    newMgr.initialize();

    expect(mockCurrentSettings.dismissedApiPrompts).toEqual(['other_prompt']);
  });

  it('identifies absent categories for Atom feed polling when categories tree is folded', () => {
    const onAbsent = vi.fn();
    accountsManager.onAbsentCategoriesChanged = onAbsent;

    // Report arrives for an account with hasCategoriesSection: true (e.g. Work), but categories tree is folded
    accountsManager.handleDomUnreadUpdate('account_personal', {
      timestamp: Date.now(),
      counts: { inbox: 2 },
      presentCategories: ['inbox'],
      hasCategoriesSection: true,
      isLoaded: true,
    });

    // For banner UI: not missing because hasCategoriesSection is true
    expect(accountsManager.getMissingCategoriesForAccount('account_personal')).toEqual([]);
    expect(accountsManager.isCategoryBannerShowing()).toBe(false);

    // For Atom feed polling: updates and social are absent from the DOM, so they must be polled!
    const absent = accountsManager.getAbsentCategoriesForAccount('account_personal');
    expect(absent).toEqual(['updates', 'social']);
    expect(onAbsent).toHaveBeenCalledWith('account_personal', ['updates', 'social']);
  });

  it('accurately blends unread counts from Atom feeds when categories are folded', () => {
    // 1. Account has inbox unread: 2 in DOM, but social is folded/absent
    accountsManager.handleDomUnreadUpdate('account_personal', {
      timestamp: Date.now(),
      counts: { inbox: 2 },
      presentCategories: ['inbox'],
      hasCategoriesSection: true,
      isLoaded: true,
    });

    // 2. Poller fetches category feed for social (via ^smartlabel_social) and reports 1 unread
    const atomCounts = new Map<NotificationCategory, number>([
      ['primary', 2],
      ['social', 1],
      ['updates', 0],
    ]);
    accountsManager.handleApiUnreadUpdate('account_personal', 3, atomCounts);

    // 3. Effective unread must be 2 (DOM inbox) + 1 (Atom social) = 3!
    const effective = accountsManager.getEffectiveUnreadForAccount('account_personal');
    expect(effective).toBe(3);
  });

  it('holds the count steady when the user folds Categories away', () => {
    // 1. Initial state from local cache: Updates holds the account's only unread message.
    accountsManager.handleCacheCategoryCounts(
      'account_personal',
      new Map<NotificationCategory, number>([
        ['primary', 0],
        ['updates', 1],
        ['promotions', 0],
        ['social', 0],
        ['forums', 0],
      ]),
    );
    // Categories expanded: every category is in the sidebar.
    accountsManager.handleDomUnreadUpdate('account_personal', {
      timestamp: Date.now(),
      counts: { inbox: 0, updates: 1, promotions: 0, social: 0, forums: 0 },
      presentCategories: ['inbox', 'updates', 'promotions', 'social', 'forums'],
      hasCategoriesSection: true,
      isLoaded: true,
    });
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(1);

    // 2. A poll lands while the section is open. Nothing is absent from the
    //    sidebar, so the poller fetches only the sub-feeds it must -- the
    //    silenced ones -- and reports no count for Updates or Social.
    accountsManager.handleApiUnreadUpdate(
      'account_personal',
      1,
      new Map<NotificationCategory, number>([
        ['promotions', 0],
        ['forums', 0],
        ['primary', 1],
      ]),
    );
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(1);

    // 3. The user folds Categories and its rows leave the sidebar. The message
    //    is still unread, so the count must not move.
    accountsManager.handleDomUnreadUpdate('account_personal', {
      timestamp: Date.now(),
      counts: { inbox: 0 },
      presentCategories: ['inbox'],
      hasCategoriesSection: true,
      isLoaded: true,
    });
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(1);
  });

  it('prevents account-wide Atom sub-feeds from clobbering inbox cache category counts', () => {
    // 1. Local cache reports 0 unread for Social (unread email was archived)
    accountsManager.handleCacheCategoryCounts(
      'account_personal',
      new Map<NotificationCategory, number>([
        ['primary', 0],
        ['social', 0],
      ]),
    );
    accountsManager.handleDomUnreadUpdate('account_personal', {
      timestamp: Date.now(),
      counts: { inbox: 0 },
      presentCategories: ['inbox'],
      hasCategoriesSection: true,
      isLoaded: true,
    });
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(0);

    // 2. Routine Atom poller sub-feed reports social: 1 (because Google's ^smartlabel_social feed
    // includes archived mail account-wide).
    accountsManager.handleApiUnreadUpdate(
      'account_personal',
      1,
      new Map<NotificationCategory, number>([
        ['primary', 0],
        ['social', 1],
      ]),
    );

    // 3. Effective unread must REMAIN 0, protected by the local cache reading!
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(0);
  });
});

/**
 * A count read off an open Gmail page is the best guess available: it is the
 * sidebar Gmail itself renders, and it moves the instant the mailbox does, where
 * the Atom feed lags by seconds and is edge-cached besides.
 *
 * These cover the cases where that guess exists but nothing on screen shows it.
 * Menu bar triage is the one that bites: it acts on a hidden window, on an account
 * that is usually not the one in front, so gating the sidebar numbers on either
 * left every count waiting for the next poll.
 */
describe('a sidebar count off screen', () => {
  let mainWindow: BaseWindow;
  let accountsManager: AccountsManager;

  const cacheReport = (primary: number) =>
    new Map<NotificationCategory, number>([
      ['primary', primary],
      ['updates', 0],
      ['social', 0],
      ['promotions', 0],
      ['forums', 0],
    ]);

  beforeEach(() => {
    mockChildren.length = 0;
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    fs.writeFileSync(
      `${TEST_USER_DATA}/accounts.json`,
      JSON.stringify([
        {
          id: 'account_personal',
          name: 'Personal',
          email: 'test@example.com',
          color: '#4285f4',
          partition: 'persist:magimail_personal',
          unreadCount: 0,
        },
        {
          id: 'account_work',
          name: 'Work',
          email: 'work@example.com',
          color: '#db4437',
          partition: 'persist:magimail_work',
          unreadCount: 0,
        },
      ]),
    );

    mainWindow = new BaseWindow();
    accountsManager = new AccountsManager(mainWindow, '/mock/preload.js');
    accountsManager.bannerSettleDelayMs = 0;
    accountsManager.initialize();
  });

  it('counts a hidden window the same as one on screen', () => {
    accountsManager.handleCacheCategoryCounts('account_personal', cacheReport(4));
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(4);
  });

  it('counts an account that is not the one in front', () => {
    accountsManager.switchAccount('account_work');
    accountsManager.handleCacheCategoryCounts('account_personal', cacheReport(2));
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(2);
  });

  it('does not let a lagging poll undo what the local cache reported during triage grace window', () => {
    accountsManager.handleCacheCategoryCounts('account_personal', cacheReport(2));
    // The feed still serves the count Gmail held before the action.
    accountsManager.handleApiUnreadUpdate('account_personal', 7);
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(2);
  });

  it('hands the account back to the feed once its grace window expires', () => {
    vi.useFakeTimers();
    accountsManager.handleCacheCategoryCounts('account_personal', cacheReport(2));
    vi.advanceTimersByTime(6000);
    accountsManager.handleApiUnreadUpdate('account_personal', 7);
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(7);
    vi.useRealTimers();
  });
});

describe('Per-Source Ledger & Authority Resolution', () => {
  let mainWindow: BaseWindow;
  let accountsManager: AccountsManager;

  const cacheReport = (primary: number) =>
    new Map<NotificationCategory, number>([
      ['primary', primary],
      ['updates', 0],
      ['social', 0],
      ['promotions', 0],
      ['forums', 0],
    ]);

  beforeEach(() => {
    vi.useFakeTimers();
    mockChildren.length = 0;
    mockCurrentSettings.dismissedApiPrompts = [];
    fs.mkdirSync(TEST_USER_DATA, { recursive: true });
    const accountsData = [
      {
        id: 'account_personal',
        name: 'Personal',
        email: 'test@example.com',
        color: '#4285f4',
        partition: 'persist:magimail_personal',
        unreadCount: 0,
      },
      {
        id: 'account_work',
        name: 'Work',
        email: 'work@example.com',
        color: '#db4437',
        partition: 'persist:magimail_work',
        unreadCount: 0,
      },
    ];
    fs.writeFileSync(`${TEST_USER_DATA}/accounts.json`, JSON.stringify(accountsData));

    mainWindow = new BaseWindow();
    accountsManager = new AccountsManager(mainWindow, '/mock/preload.js');
    accountsManager.bannerSettleDelayMs = 0;
    accountsManager.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows Atom poll to win when outside the 5s triage grace window (external triage on phone)', () => {
    // 1. Desktop local cache reports 4 unread messages
    accountsManager.handleCacheCategoryCounts('account_personal', cacheReport(4));
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(4);

    // 2. User marks 2 emails as read on their phone.
    // 6 seconds later, desktop background poller fetches feed and returns 2.
    vi.advanceTimersByTime(6000);
    accountsManager.handleApiUnreadUpdate('account_personal', 2);

    // Outside the 5s grace window, Atom poll wins over the stale desktop cache!
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(2);
    const acc = accountsManager.getAccounts().find((a) => a.id === 'account_personal');
    expect(acc?.unreadCount).toBe(2);
  });

  it('allows Atom poll to increment when new mail arrives externally', () => {
    // 1. Initial cache report has 1 unread
    accountsManager.handleCacheCategoryCounts('account_personal', cacheReport(1));
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(1);

    // 2. New emails arrive; Atom poll discovers 5 unread outside grace window
    vi.advanceTimersByTime(6000);
    accountsManager.handleApiUnreadUpdate('account_personal', 5);

    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(5);
  });

  it('tray Refresh Inbox immediately clears cache grace window so forced poll wins', () => {
    // 1. User archives email in cache -> count drops to 3
    accountsManager.handleCacheCategoryCounts('account_personal', cacheReport(3));
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(3);

    // 2. Inside the grace window (only 1s elapsed), user clicks "Refresh Inbox" in tray
    vi.advanceTimersByTime(1000);
    accountsManager.resetTriageGraceWindow('account_personal');

    // 3. Forced poll arrives with server state 1 (external changes happened)
    accountsManager.handleApiUnreadUpdate('account_personal', 1);

    // Forced poll wins immediately without waiting out the 5s window!
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(1);
  });

  it('multi-account isolation: local triage in Account A does not block external poll updates in Account B', () => {
    // 1. Account Personal has fresh cache triage (grace window active)
    accountsManager.handleCacheCategoryCounts('account_personal', cacheReport(3));

    // 2. Account Work receives an Atom poll 1s later reflecting 8 unread
    vi.advanceTimersByTime(1000);
    accountsManager.handleApiUnreadUpdate('account_work', 8);

    // Personal holds its local triage count (3), while Work immediately applies 8!
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(3);
    expect(accountsManager.getEffectiveUnreadForAccount('account_work')).toBe(8);
  });

  it('cache vs atom freshness timestamp arbitration', () => {
    // 1. Atom poll arrives at T=1000 reporting 4
    vi.setSystemTime(1000);
    accountsManager.handleApiUnreadUpdate('account_personal', 4);
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(4);

    // 2. Gmail /sync/ runs at T=2000, updating local cache (_xdb)
    vi.setSystemTime(2000);
    accountsManager.handleCacheCategoryCounts(
      'account_personal',
      new Map<NotificationCategory, number>([
        ['primary', 1],
        ['updates', 1],
        ['promotions', 0],
        ['social', 0],
        ['forums', 0],
      ]),
      2000,
    );

    // Since cache timestamp (2000) > atom timestamp (1000), cache breakdown wins (1 primary + 1 updates = 2)
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(2);

    // 3. Next Atom poll finishes at T=8000 (outside 5s grace window) reporting 1
    vi.setSystemTime(8000);
    accountsManager.handleApiUnreadUpdate('account_personal', 1);

    // Since atom timestamp (8000) > cache timestamp (2000) and > 5s elapsed, Atom poll wins!
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(1);
  });

  it('drops unread cleanly to zero when mailbox is cleared', () => {
    // Initial state: 3 unread in cache
    accountsManager.handleCacheCategoryCounts('account_personal', cacheReport(3));
    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(3);

    // Outside grace window, Atom poll returns 0
    vi.advanceTimersByTime(6000);
    accountsManager.handleApiUnreadUpdate('account_personal', 0);

    expect(accountsManager.getEffectiveUnreadForAccount('account_personal')).toBe(0);
    const acc = accountsManager.getAccounts().find((a) => a.id === 'account_personal');
    expect(acc?.unreadCount).toBe(0);
  });

  it('pressGmailRefreshControl executes refresh script on open view', async () => {
    // Open a view for personal account
    await accountsManager.openInAccount(
      'account_personal',
      'https://mail.google.com/mail/u/0/#inbox',
    );
    const view = accountsManager.getWebContentsViewForAccount('account_personal');
    expect(view).toBeDefined();

    await accountsManager.pressGmailRefreshControl('account_personal');
    expect(view?.webContents.executeJavaScript).toHaveBeenCalled();
  });
});
