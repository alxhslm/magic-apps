import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chooseEventAccount } from '../src/account-picker.js';
import { dialog } from 'electron';

const addEventAccountPicker = { value: 'active' as 'active' | 'ask' };

vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn(() => ({ addEventAccountPicker: addEventAccountPicker.value })),
}));

vi.mock('electron', () => ({
  dialog: {
    showMessageBox: vi.fn(),
  },
}));

describe('chooseEventAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addEventAccountPicker.value = 'active';
  });

  const mockManager = (accounts: { id: string; name: string }[], activeId: string) => ({
    getAccounts: () => accounts as any,
    getActiveAccountId: () => activeId,
  });

  it('returns active account without asking when only 1 account exists', async () => {
    const manager = mockManager([{ id: 'acc1', name: 'Work' }], 'acc1');
    const result = await chooseEventAccount(manager as any, { fromMainWindow: true });
    expect(result?.id).toBe('acc1');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('returns active account from main window when setting is active', async () => {
    const manager = mockManager(
      [
        { id: 'acc1', name: 'Work' },
        { id: 'acc2', name: 'Personal' },
      ],
      'acc2',
    );
    addEventAccountPicker.value = 'active';
    const result = await chooseEventAccount(manager as any, { fromMainWindow: true });
    expect(result?.id).toBe('acc2');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('never asks from the main window, even when the setting says always ask', async () => {
    const manager = mockManager(
      [
        { id: 'acc1', name: 'Work' },
        { id: 'acc2', name: 'Personal' },
      ],
      'acc2',
    );
    addEventAccountPicker.value = 'ask';
    const result = await chooseEventAccount(manager as any, { fromMainWindow: true });
    expect(result?.id).toBe('acc2');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('uses the active account off the window when the setting says use active', async () => {
    const manager = mockManager(
      [
        { id: 'acc1', name: 'Work' },
        { id: 'acc2', name: 'Personal' },
      ],
      'acc2',
    );
    addEventAccountPicker.value = 'active';
    const result = await chooseEventAccount(manager as any, { fromMainWindow: false });
    expect(result?.id).toBe('acc2');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('prompts off the window when the setting is ask', async () => {
    const manager = mockManager(
      [
        { id: 'acc1', name: 'Work' },
        { id: 'acc2', name: 'Personal' },
      ],
      'acc1',
    );
    addEventAccountPicker.value = 'ask';
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });

    const result = await chooseEventAccount(manager as any, { fromMainWindow: false });
    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(result?.id).toBe('acc2');
  });

  it('prompts off the window under forceAsk even when the setting says use active', async () => {
    const manager = mockManager(
      [
        { id: 'acc1', name: 'Work' },
        { id: 'acc2', name: 'Personal' },
      ],
      'acc1',
    );
    addEventAccountPicker.value = 'active';
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });

    const result = await chooseEventAccount(manager as any, { forceAsk: true });
    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(result?.id).toBe('acc2');
  });

  it('returns null when user cancels dialog', async () => {
    const manager = mockManager(
      [
        { id: 'acc1', name: 'Work' },
        { id: 'acc2', name: 'Personal' },
      ],
      'acc1',
    );
    addEventAccountPicker.value = 'ask';
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 2, checkboxChecked: false });

    const result = await chooseEventAccount(manager as any, { fromMainWindow: false });
    expect(result).toBeNull();
  });
});
