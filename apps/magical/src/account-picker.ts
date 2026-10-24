import { dialog, type BaseWindow } from 'electron';
import type { CalendarAccount } from './accounts.js';
import type { AccountsManager } from './accounts-manager.js';
import { loadSettings } from './settings-store.js';
import { uiString } from './strings.js';

export interface EventAccountOptions {
  /** Second line of the alert, naming what is about to be created. */
  detail?: string;
  /** Window title of the alert. Names the action the account is being chosen for. */
  title?: string;
  /** First line of the alert, in bold. */
  message?: string;
  /** Window to hang the alert off as a sheet. Without one it goes up parentless. */
  parentWindow?: BaseWindow | null;
  /**
   * The request came from the main window, where the active account is on screen. The
   * account the user is looking at always stands in there, so the picker never appears:
   * `addEventAccountPicker` settles an entry point that arrives from outside the window —
   * the menu bar, a widget, a deep link — where there is no account on screen to assume.
   */
  fromMainWindow?: boolean;
  /**
   * Ask even off the main window and even under `addEventAccountPicker: 'active'`.
   * For an entry point whose account genuinely cannot be assumed — an `.ics` file from
   * Finder or Mail has no account on screen to have been the one meant.
   */
  forceAsk?: boolean;
}

/**
 * Asks which account to create an event in. Returns the active account when there is
 * nothing to ask, and null when cancelled. Does not switch accounts — the caller
 * decides whether to switch.
 */
export async function chooseEventAccount(
  accountsManager: AccountsManager,
  {
    detail,
    title = uiString('dialog.eventAccount.title'),
    message = uiString('dialog.eventAccount.message'),
    parentWindow,
    fromMainWindow = false,
    forceAsk = false,
  }: EventAccountOptions = {},
): Promise<CalendarAccount | null> {
  const accounts = accountsManager.getAccounts();
  const activeAccountId = accountsManager.getActiveAccountId();
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0] ?? null;

  if (accounts.length <= 1) return active;
  if (!forceAsk) {
    // Inside the window the account on screen is the answer, whatever the setting says.
    if (fromMainWindow) return active;
    // Off the window the setting settles it: "Use active account" still stands in for an
    // answer, "Always ask" opens the picker.
    if (loadSettings().addEventAccountPicker === 'active') return active;
  }

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
    title,
    message,
    detail: detail || uiString('dialog.eventAccount.detail'),
  };

  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);

  if (response < 0 || response >= accounts.length) return null;
  return accounts[response];
}
