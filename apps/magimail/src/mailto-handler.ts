import { BaseWindow } from 'electron';
import { parseMailtoUri } from './mailto.js';
import { type AccountsManager } from './accounts-manager.js';
import { chooseComposeAccount } from './account-picker.js';
import { uiString } from './strings.js';

/**
 * Asks which account to compose from, switches to it, and returns true.
 * Returns false if cancelled.
 */
export async function pickAccount(
  accountsManager: AccountsManager,
  mainWindow: BaseWindow | null | undefined,
  detail?: string,
): Promise<boolean> {
  const account = await chooseComposeAccount(accountsManager, {
    parentWindow: mainWindow,
    detail,
  });
  if (!account) return false;
  if (account.id !== accountsManager.getActiveAccountId()) {
    accountsManager.switchAccount(account.id);
  }
  return true;
}

/**
 * Handles incoming mailto: protocol URLs by opening Gmail's native
 * compose pop-out with fields pre-filled via URL params.
 */
export async function handleMailtoUrl({
  url,
  accountsManager,
  mainWindow,
}: {
  url: string;
  accountsManager: AccountsManager;
  mainWindow?: BaseWindow | null;
}): Promise<void> {
  if (!url || !url.startsWith('mailto:')) return;

  const recipient =
    url.substring(7).split('?')[0] || uiString('dialog.composeAccount.recipientFallback');
  const picked = await pickAccount(
    accountsManager,
    mainWindow,
    uiString('dialog.composeAccount.mailtoDetail', { recipient }),
  );
  if (!picked) return;

  const params = parseMailtoUri(url);
  const fields = {
    to: params.to || undefined,
    cc: params.cc || undefined,
    bcc: params.bcc || undefined,
    subject: params.subject || undefined,
    body: params.body || undefined,
  };

  const hasFields = Object.values(fields).some(Boolean);
  await accountsManager.triggerComposePopout(hasFields ? fields : undefined);
}
