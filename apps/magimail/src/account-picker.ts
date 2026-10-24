import { dialog, type BaseWindow } from 'electron';
import type { AccountConfig } from '@magimail/core';
import { type AccountsManager } from './accounts-manager.js';
import { loadSettings } from './settings-store.js';
import { uiString } from './strings.js';

export interface ComposeAccountOptions {
  /** Second line of the alert, naming what is about to be composed. */
  detail?: string;
  /** Window to hang the alert off as a sheet. Without one it goes up parentless. */
  parentWindow?: BaseWindow | null;
  /**
   * The request came from the main window, where the active account is on
   * screen. Only there can `composeAccountPicker: 'active'` stand in for an
   * answer — every other surface reaches the app from outside it, with no
   * account on screen to be the active one.
   */
  fromMainWindow?: boolean;
}

/**
 * Asks which account to compose from. Returns the active account when there is
 * nothing to ask, and null when cancelled. Does not switch accounts — the caller
 * decides whether its surface implies one.
 */
export async function chooseComposeAccount(
  accountsManager: AccountsManager,
  { detail, parentWindow, fromMainWindow = false }: ComposeAccountOptions = {},
): Promise<AccountConfig | null> {
  const accounts = accountsManager.getAccounts();
  const activeAccountId = accountsManager.getActiveAccountId();
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0] ?? null;

  if (accounts.length <= 1) return active;
  if (fromMainWindow && loadSettings().composeAccountPicker === 'active') return active;

  const parent = parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;

  const buttons = accounts.map((a) => uiString('dialog.accountPicker.button', { name: a.name }));
  buttons.push(uiString('dialog.cancel'));

  const options = {
    type: 'question' as const,
    buttons,
    defaultId: Math.max(
      0,
      accounts.findIndex((a) => a.id === active?.id),
    ),
    cancelId: accounts.length,
    title: uiString('dialog.composeAccount.title'),
    message: uiString('dialog.composeAccount.message'),
    detail: detail || uiString('dialog.composeAccount.detail'),
  };

  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);

  if (response < 0 || response >= accounts.length) return null;
  return accounts[response];
}
