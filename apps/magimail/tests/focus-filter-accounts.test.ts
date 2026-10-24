import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseWindow } from 'electron';
import { AccountsManager } from '../src/accounts-manager.js';
import { updateNativeToolbarAccounts } from '../src/native-toolbar.js';
import { updateDockBadge } from '../src/dock.js';

vi.mock('../src/native-toolbar.js', () => ({
  attachNativeToolbar: vi.fn(),
  updateNativeToolbarAccounts: vi.fn(),
  setNativeToolbarItemEnabled: vi.fn(),
  setNativeToolbarShareUrl: vi.fn(),
  showNativeSharingPicker: vi.fn(),
}));

vi.mock('../src/dock.js', () => ({
  updateDockBadge: vi.fn(),
}));

vi.mock('../src/account-store.js', () => ({
  loadAccounts: vi.fn().mockReturnValue([
    {
      id: 'account_personal',
      name: 'Personal',
      partition: 'persist:magimail_personal',
      color: '#a855f7',
      unreadCount: 0,
    },
    {
      id: 'account_work',
      name: 'Work',
      partition: 'persist:magimail_work',
      color: '#3b82f6',
      unreadCount: 0,
    },
  ]),
  saveAccounts: vi.fn(),
  createNewAccount: vi.fn(),
}));

vi.mock('@magimail/core', async () => {
  const actual = await vi.importActual<typeof import('@magimail/core')>('@magimail/core');
  return {
    ...actual,
    configureGoogleSession: vi.fn(),
    injectGmailStyles: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('electron', () => {
  const mockWebContents = {
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue(''),
    isDestroyed: vi.fn().mockReturnValue(false),
    executeJavaScript: vi.fn().mockResolvedValue(false),
    getURL: vi.fn().mockReturnValue('https://mail.google.com/mail/u/0/#inbox'),
    setBackgroundThrottling: vi.fn(),
    mainFrame: { frames: [] },
  };

  class MockWebContentsView {
    webContents = { ...mockWebContents };
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();
  }

  const mockChildren: unknown[] = [];
  const mockContentView = {
    children: mockChildren,
    addChildView: vi.fn((view: unknown) => {
      mockChildren.push(view);
    }),
    removeChildView: vi.fn((view: unknown) => {
      const idx = mockChildren.indexOf(view);
      if (idx !== -1) mockChildren.splice(idx, 1);
    }),
  };

  class MockBaseWindow {
    contentView = mockContentView;
    on = vi.fn();
    getContentSize = vi.fn().mockReturnValue([1024, 768]);
    getNativeWindowHandle = vi.fn().mockReturnValue(Buffer.from('mock-handle'));
    isDestroyed = vi.fn().mockReturnValue(false);
    setBackgroundColor = vi.fn();
  }

  return {
    BaseWindow: MockBaseWindow,
    WebContentsView: MockWebContentsView,
    app: {
      getPath: vi.fn().mockReturnValue('/tmp/test-magimail'),
      focus: vi.fn(),
    },
    shell: { openExternal: vi.fn() },
    dialog: { showSaveDialog: vi.fn() },
  };
});

describe('AccountsManager Focus Filter Integration', () => {
  let accountsManager: AccountsManager;
  let mockWindow: BaseWindow;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWindow = new BaseWindow();
    accountsManager = new AccountsManager(mockWindow, '/mock/preload.js');
    accountsManager.initialize();
  });

  it('keeps every account in the switcher, with and without a filter', () => {
    const all = accountsManager.getAccounts();
    expect(all.length).toBeGreaterThan(1);
    expect(accountsManager.getVisibleAccounts()).toEqual(all);
    expect(accountsManager.getFocusFilter()).toBeNull();

    accountsManager.setFocusFilter({
      activeAccountIds: [all[0].id],
      disableExcludedAccounts: true,
    });

    // Even disabled, an excluded account keeps its place: removing it would
    // leave no way back to that mailbox.
    expect(accountsManager.getVisibleAccounts()).toEqual(all);
  });

  it('narrows the focused list to the accounts the filter includes', () => {
    const all = accountsManager.getAccounts();
    const target = all[0].id;

    accountsManager.setFocusFilter({
      activeAccountIds: [target],
      disableExcludedAccounts: false,
    });

    const focused = accountsManager.getFocusedAccounts();
    expect(focused.length).toBe(1);
    expect(focused[0].id).toBe(target);
  });

  it('marks excluded accounts, and disables them only when asked', () => {
    const all = accountsManager.getAccounts();
    const [included, excluded] = all;

    accountsManager.setFocusFilter({
      activeAccountIds: [included.id],
      disableExcludedAccounts: false,
    });
    expect(accountsManager.isExcludedByFocus(excluded.id)).toBe(true);
    expect(accountsManager.isExcludedByFocus(included.id)).toBe(false);
    expect(accountsManager.isDisabledByFocus(excluded.id)).toBe(false);

    accountsManager.setFocusFilter({
      activeAccountIds: [included.id],
      disableExcludedAccounts: true,
    });
    expect(accountsManager.isDisabledByFocus(excluded.id)).toBe(true);
    expect(accountsManager.isDisabledByFocus(included.id)).toBe(false);
  });

  it('tells the toolbar which accounts to dim and which to disable', () => {
    const all = accountsManager.getAccounts();
    const [included, excluded] = all;

    accountsManager.setFocusFilter({
      activeAccountIds: [included.id],
      disableExcludedAccounts: true,
    });

    const [accounts] = vi.mocked(updateNativeToolbarAccounts).mock.calls.at(-1)!;
    expect(accounts.length).toBe(all.length);
    const sent = (id: string) => accounts.find((a) => a.id === id)!;
    expect(sent(excluded.id).excludedByFocus).toBe(true);
    expect(sent(excluded.id).disabledByFocus).toBe(true);
    expect(sent(included.id).excludedByFocus).toBe(false);
    expect(sent(included.id).disabledByFocus).toBe(false);
  });

  it('does not move you off an account that is merely de-emphasised', () => {
    const all = accountsManager.getAccounts();
    const [acc1, acc2] = all;

    accountsManager.switchAccount(acc2.id);
    accountsManager.setFocusFilter({
      activeAccountIds: [acc1.id],
      disableExcludedAccounts: false,
    });

    // Silenced, dimmed -- but still the account you are reading.
    expect(accountsManager.getActiveAccountId()).toBe(acc2.id);
  });

  it('moves you off an account the filter disables', () => {
    const all = accountsManager.getAccounts();
    const [acc1, acc2] = all;

    accountsManager.switchAccount(acc2.id);
    accountsManager.setFocusFilter({
      activeAccountIds: [acc1.id],
      disableExcludedAccounts: true,
    });

    expect(accountsManager.getActiveAccountId()).toBe(acc1.id);
  });

  it('refuses a keyboard switch to a disabled account but allows a dimmed one', () => {
    const all = accountsManager.getAccounts();
    const [acc1, acc2] = all;
    const indexOfAcc2 = all.findIndex((a) => a.id === acc2.id);

    accountsManager.setFocusFilter({
      activeAccountIds: [acc1.id],
      disableExcludedAccounts: true,
    });
    accountsManager.switchToIndex(indexOfAcc2);
    expect(accountsManager.getActiveAccountId()).not.toBe(acc2.id);

    accountsManager.setFocusFilter({
      activeAccountIds: [acc1.id],
      disableExcludedAccounts: false,
    });
    accountsManager.switchToIndex(indexOfAcc2);
    expect(accountsManager.getActiveAccountId()).toBe(acc2.id);
  });

  it('counts only focused accounts in the dock badge', () => {
    const all = accountsManager.getAccounts();
    const [acc1, acc2] = all;

    accountsManager.handleApiUnreadUpdate(acc1.id, 5);
    accountsManager.handleApiUnreadUpdate(acc2.id, 10);
    expect(updateDockBadge).toHaveBeenLastCalledWith(15, { count: 0, incomplete: false });

    // Excluding acc2 drops it from the badge even though it stays in the UI,
    // and even though the filter only de-emphasises rather than disables.
    accountsManager.setFocusFilter({
      activeAccountIds: [acc1.id],
      disableExcludedAccounts: false,
    });
    expect(updateDockBadge).toHaveBeenLastCalledWith(5, { count: 0, incomplete: false });

    accountsManager.handleApiUnreadUpdate(acc2.id, 20);
    expect(updateDockBadge).toHaveBeenLastCalledWith(5, { count: 0, incomplete: false });

    accountsManager.setFocusFilter(null);
    expect(updateDockBadge).toHaveBeenLastCalledWith(25, { count: 0, incomplete: false });
  });

  it('marks the badge a floor when any focused account had its feed cut short', () => {
    const [acc1, acc2] = accountsManager.getAccounts();

    accountsManager.handleApiUnreadUpdate(acc1.id, 5, undefined, 2, false);
    accountsManager.handleApiUnreadUpdate(acc2.id, 400, undefined, 6, true);
    // One account short of the truth makes the sum short of the truth.
    expect(updateDockBadge).toHaveBeenLastCalledWith(405, { count: 8, incomplete: true });

    // Excluding the big account leaves an exact count behind.
    accountsManager.setFocusFilter({
      activeAccountIds: [acc1.id],
      disableExcludedAccounts: false,
    });
    expect(updateDockBadge).toHaveBeenLastCalledWith(5, { count: 2, incomplete: false });

    // And it clears once that account's feed comes back whole.
    accountsManager.setFocusFilter(null);
    accountsManager.handleApiUnreadUpdate(acc2.id, 12, undefined, 6, false);
    expect(updateDockBadge).toHaveBeenLastCalledWith(17, { count: 8, incomplete: false });
  });

  it('filters new arrivals by focus alongside the unread total', () => {
    const [acc1, acc2] = accountsManager.getAccounts();

    accountsManager.handleApiUnreadUpdate(acc1.id, 5, undefined, 2, false);
    accountsManager.handleApiUnreadUpdate(acc2.id, 10, undefined, 3, false);
    expect(updateDockBadge).toHaveBeenLastCalledWith(15, { count: 5, incomplete: false });

    accountsManager.setFocusFilter({
      activeAccountIds: [acc1.id],
      disableExcludedAccounts: false,
    });
    expect(updateDockBadge).toHaveBeenLastCalledWith(5, { count: 2, incomplete: false });

    accountsManager.setFocusFilter(null);
    expect(updateDockBadge).toHaveBeenLastCalledWith(15, { count: 5, incomplete: false });
  });

  it('restores everything when the filter is deactivated', () => {
    const all = accountsManager.getAccounts();

    accountsManager.setFocusFilter({
      activeAccountIds: [all[0].id],
      disableExcludedAccounts: true,
    });
    expect(accountsManager.getFocusedAccounts().length).toBe(1);

    accountsManager.setFocusFilter(null);
    expect(accountsManager.getFocusedAccounts().length).toBe(all.length);
    expect(accountsManager.getVisibleAccounts().length).toBe(all.length);
    expect(accountsManager.isExcludedByFocus(all[1].id)).toBe(false);
    expect(accountsManager.getFocusFilter()).toBeNull();
  });
});
