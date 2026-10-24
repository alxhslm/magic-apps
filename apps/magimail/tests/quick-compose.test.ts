import { describe, it, expect, vi, beforeEach } from 'vitest';
import { dialog, globalShortcut, app } from 'electron';
import { chooseComposeAccount } from '../src/account-picker.js';
import {
  openQuickCompose,
  releaseQuickComposeShortcut,
  resolveQuickComposeChord,
  setQuickComposeShortcut,
} from '../src/quick-compose.js';
import { openDetachedComposeWindow } from '../src/compose.js';
import { focusToField } from '../src/compose-fields.js';

vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  BrowserWindow: vi.fn(),
  BaseWindow: vi.fn(),
}));

const composeAccountPicker = { value: 'active' as 'active' | 'ask' };
vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn(() => ({ composeAccountPicker: composeAccountPicker.value })),
  QUICK_COMPOSE_CHORDS: [
    'off',
    'Alt+Command+C',
    'Control+Command+C',
    'Shift+Command+C',
    'Control+Alt+Command+C',
  ],
  DEFAULT_QUICK_COMPOSE_CHORD: 'Alt+Command+C',
}));

vi.mock('../src/compose.js', () => ({
  openDetachedComposeWindow: vi.fn(() => ({
    setTitle: vi.fn(),
    once: vi.fn(),
    focus: vi.fn(),
  })),
}));

vi.mock('../src/compose-fields.js', () => ({
  focusToField: vi.fn().mockResolvedValue(true),
}));

const ACCOUNTS = [
  { id: 'p', name: 'Personal', partition: 'persist:p', color: '#000', unreadCount: 0 },
  { id: 'w', name: 'Work', partition: 'persist:w', color: '#111', unreadCount: 0 },
];

function mockAccountsManager(accounts = ACCOUNTS, activeId = 'p') {
  return {
    getAccounts: () => accounts,
    getActiveAccountId: () => activeId,
    switchAccount: vi.fn(),
  } as unknown as import('../src/accounts-manager.js').AccountsManager;
}

beforeEach(() => {
  vi.clearAllMocks();
  composeAccountPicker.value = 'active';
  releaseQuickComposeShortcut();
});

describe('chooseComposeAccount', () => {
  it('returns the active account without asking when only one exists', async () => {
    const mgr = mockAccountsManager([ACCOUNTS[0]]);
    await expect(chooseComposeAccount(mgr)).resolves.toEqual(ACCOUNTS[0]);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('asks from outside the main window even when the setting says active', async () => {
    const mgr = mockAccountsManager();
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 1,
      checkboxChecked: false,
    });

    await expect(chooseComposeAccount(mgr)).resolves.toEqual(ACCOUNTS[1]);
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('goes up parentless when given no window', async () => {
    const mgr = mockAccountsManager();
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 0,
      checkboxChecked: false,
    });

    await chooseComposeAccount(mgr);

    // Parentless alerts take the options object as the sole argument.
    expect(vi.mocked(dialog.showMessageBox).mock.calls[0]).toHaveLength(1);
  });

  it('honours composeAccountPicker only from the main window', async () => {
    const mgr = mockAccountsManager();
    const parent = { isDestroyed: () => false } as unknown as import('electron').BaseWindow;

    await expect(
      chooseComposeAccount(mgr, { parentWindow: parent, fromMainWindow: true }),
    ).resolves.toEqual(ACCOUNTS[0]);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('asks from the main window when the setting says to', async () => {
    const mgr = mockAccountsManager();
    const parent = { isDestroyed: () => false } as unknown as import('electron').BaseWindow;
    composeAccountPicker.value = 'ask';
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 1,
      checkboxChecked: false,
    });

    await expect(
      chooseComposeAccount(mgr, { parentWindow: parent, fromMainWindow: true }),
    ).resolves.toEqual(ACCOUNTS[1]);
  });

  it('returns null when cancelled', async () => {
    const mgr = mockAccountsManager();
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 2,
      checkboxChecked: false,
    });

    await expect(chooseComposeAccount(mgr)).resolves.toBeNull();
  });
});

describe('openQuickCompose', () => {
  it('composes into the chosen account without switching the active one', async () => {
    const mgr = mockAccountsManager();
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 1,
      checkboxChecked: false,
    });

    const win = await openQuickCompose({ accountsManager: mgr, preloadPath: '/preload.js' });

    expect(win).not.toBeNull();
    expect(app.focus).toHaveBeenCalledWith({ steal: true });
    expect(openDetachedComposeWindow).toHaveBeenCalledWith(
      '/preload.js',
      'persist:w',
      undefined,
      undefined,
    );
    expect(mgr.switchAccount).not.toHaveBeenCalled();
    expect(focusToField).toHaveBeenCalled();
  });

  it('opens nothing when the picker is cancelled', async () => {
    const mgr = mockAccountsManager();
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 2,
      checkboxChecked: false,
    });

    await expect(
      openQuickCompose({ accountsManager: mgr, preloadPath: '/preload.js' }),
    ).resolves.toBeNull();
    expect(openDetachedComposeWindow).not.toHaveBeenCalled();
  });
});

describe('resolveQuickComposeChord', () => {
  it('keeps a chord the picker offers', () => {
    expect(resolveQuickComposeChord('Control+Command+C')).toBe('Control+Command+C');
    expect(resolveQuickComposeChord('off')).toBe('off');
  });

  it('falls back to the default for anything it does not recognise', () => {
    // A hand-edited settings.json, or a chord dropped from a later build.
    expect(resolveQuickComposeChord('Command+Shift+Q')).toBe('Alt+Command+C');
    expect(resolveQuickComposeChord(undefined)).toBe('Alt+Command+C');
  });
});

describe('setQuickComposeShortcut', () => {
  it('registers the chosen chord', () => {
    const handler = vi.fn();
    expect(setQuickComposeShortcut('Shift+Command+C', handler)).toBe('Shift+Command+C');
    expect(globalShortcut.register).toHaveBeenCalledWith('Shift+Command+C', handler);
  });

  it('holds nothing when set to off', () => {
    expect(setQuickComposeShortcut('off', vi.fn())).toBeNull();
    expect(globalShortcut.register).not.toHaveBeenCalled();
  });

  it('releases the chord it held before taking another', () => {
    setQuickComposeShortcut('Alt+Command+C', vi.fn());
    setQuickComposeShortcut('Control+Command+C', vi.fn());

    expect(globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith('Alt+Command+C');
    expect(globalShortcut.register).toHaveBeenLastCalledWith(
      'Control+Command+C',
      expect.any(Function),
    );
  });

  it('releases the held chord when switched off', () => {
    setQuickComposeShortcut('Alt+Command+C', vi.fn());
    expect(setQuickComposeShortcut('off', vi.fn())).toBeNull();
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Alt+Command+C');
  });

  it('reports failure when another application already owns the chord', () => {
    vi.mocked(globalShortcut.register).mockReturnValueOnce(false);
    expect(setQuickComposeShortcut('Alt+Command+C', vi.fn())).toBeNull();
  });

  it('does not unregister a chord it never held', () => {
    setQuickComposeShortcut('off', vi.fn());
    expect(globalShortcut.unregister).not.toHaveBeenCalled();
  });
});
