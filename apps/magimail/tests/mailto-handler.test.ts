import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleMailtoUrl, pickAccount } from '../src/mailto-handler.js';
import { dialog, type BaseWindow } from 'electron';

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: vi.fn(),
  },
  BaseWindow: vi.fn(),
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn(() => ({
    composeAccountPicker: 'ask',
    hidePromotionAds: false,
    hideSidebar: false,
  })),
}));

function mockAccountsManager(accounts: { id: string; name: string; partition: string }[]) {
  return {
    getAccounts: () => accounts.map((a) => ({ ...a, color: '#000', unreadCount: 0 })),
    getActiveAccountId: () => accounts[0]?.id || '',
    switchAccount: vi.fn(),
    triggerComposePopout: vi.fn().mockResolvedValue(null),
  } as unknown as import('../src/accounts-manager.js').AccountsManager;
}

describe('handleMailtoUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores non-mailto urls', async () => {
    const mgr = mockAccountsManager([{ id: 'p', name: 'Personal', partition: 'persist:p' }]);
    await handleMailtoUrl({ url: 'https://example.com', accountsManager: mgr });
    expect(mgr.triggerComposePopout).not.toHaveBeenCalled();
  });

  it('calls triggerComposePopout with params for single account', async () => {
    const mgr = mockAccountsManager([{ id: 'p', name: 'Personal', partition: 'persist:p' }]);
    await handleMailtoUrl({
      url: 'mailto:test@example.com?subject=Hello&body=Hi',
      accountsManager: mgr,
    });

    expect(mgr.triggerComposePopout).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'test@example.com',
        subject: 'Hello',
        body: 'Hi',
      }),
    );
  });

  it('shows account picker with multiple accounts', async () => {
    const accounts = [
      { id: 'p', name: 'Personal', partition: 'persist:p' },
      { id: 'w', name: 'Work', partition: 'persist:w' },
    ];
    const mgr = mockAccountsManager(accounts);
    const win = { isDestroyed: () => false } as unknown as BaseWindow;

    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 1,
      checkboxChecked: false,
    });

    await handleMailtoUrl({
      url: 'mailto:team@example.com',
      accountsManager: mgr,
      mainWindow: win,
    });

    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(mgr.switchAccount).toHaveBeenCalledWith('w');
    expect(mgr.triggerComposePopout).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'team@example.com',
      }),
    );
  });

  it('cancels if account picker is dismissed', async () => {
    const accounts = [
      { id: 'p', name: 'Personal', partition: 'persist:p' },
      { id: 'w', name: 'Work', partition: 'persist:w' },
    ];
    const mgr = mockAccountsManager(accounts);
    const win = { isDestroyed: () => false } as unknown as BaseWindow;

    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 2, // Cancel
      checkboxChecked: false,
    });

    await handleMailtoUrl({
      url: 'mailto:test@example.com',
      accountsManager: mgr,
      mainWindow: win,
    });

    expect(mgr.triggerComposePopout).not.toHaveBeenCalled();
  });
});

describe('pickAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true immediately with single account', async () => {
    const mgr = mockAccountsManager([{ id: 'p', name: 'Personal', partition: 'persist:p' }]);
    const result = await pickAccount(mgr, null);
    expect(result).toBe(true);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('asks parentless rather than guessing when there is no window', async () => {
    const accounts = [
      { id: 'p', name: 'Personal', partition: 'persist:p' },
      { id: 'w', name: 'Work', partition: 'persist:w' },
    ];
    const mgr = mockAccountsManager(accounts);
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 1,
      checkboxChecked: false,
    });

    const result = await pickAccount(mgr, null);
    expect(result).toBe(true);
    expect(vi.mocked(dialog.showMessageBox).mock.calls[0]).toHaveLength(1);
    expect(mgr.switchAccount).toHaveBeenCalledWith('w');
  });
});
