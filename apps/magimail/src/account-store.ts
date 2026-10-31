import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { type AccountConfig, DEFAULT_ACCOUNTS, newAccountId } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { appGroupContainerPath } from './native-widgets.js';

const log = createLogger('Accounts');

const ACCOUNTS_FILENAME = 'accounts.json';

/**
 * Where the App Intents extension reads the account list for the Focus Filter
 * picker.
 *
 * In the App Group container, which the app and the extension are both entitled
 * for. Application Support is only the pre-group fallback, for a build whose
 * signature carries no group.
 */
function getAccountsPath(): string {
  const group = appGroupContainerPath();
  if (group) return path.join(group, ACCOUNTS_FILENAME);
  return legacyAccountsPath();
}

/** The pre-group location, read once to migrate an existing install. */
function legacyAccountsPath(): string {
  const userData =
    typeof app?.getPath === 'function' ? app.getPath('userData') : '/tmp/magimail-accounts';
  return path.join(userData, ACCOUNTS_FILENAME);
}

/** Parses one accounts file, or null when it is absent, empty or unreadable. */
function readAccountsFile(filePath: string): AccountConfig[] | null {
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        return data;
      }
    }
  } catch (err) {
    // The user's configured accounts are then replaced by a single one called
    // "Personal", which is indistinguishable from a fresh install.
    log.error('accounts.json could not be read; falling back to the defaults:', err);
  }
  return null;
}

export function loadAccounts(): AccountConfig[] {
  const group = appGroupContainerPath();
  if (group) {
    const primary = path.join(group, ACCOUNTS_FILENAME);
    const fromGroup = readAccountsFile(primary);
    if (fromGroup) return fromGroup;
    // First run with the group: copy the old file into the group so the Focus
    // Filter picker is not empty until the user next changes an account.
    const fromLegacy = readAccountsFile(legacyAccountsPath());
    if (fromLegacy) {
      try {
        const shared = fromLegacy.map(
          ({ unreadCount: _total, badgeUnreadCount: _badge, ...rest }) => rest,
        );
        fs.writeFileSync(primary, JSON.stringify(shared, null, 2), 'utf8');
        log.info('Migrated accounts.json into the App Group container');
      } catch (err) {
        log.warn('Could not migrate accounts.json into the App Group container:', err);
      }
      return fromLegacy;
    }
  } else {
    const fromLegacy = readAccountsFile(legacyAccountsPath());
    if (fromLegacy) return fromLegacy;
  }
  return [...DEFAULT_ACCOUNTS];
}

export function saveAccounts(accounts: AccountConfig[]): void {
  try {
    const filePath = getAccountsPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // The counts are left out: this file is shared with the App Intents extension,
    // which reads it for the Focus Filter picker and cannot decrypt, so it carries
    // the account list and nothing else. `unread-count-store` keeps the counts,
    // sealed.
    const shared = accounts.map(
      ({ unreadCount: _total, badgeUnreadCount: _badge, ...rest }) => rest,
    );
    fs.writeFileSync(filePath, JSON.stringify(shared, null, 2), 'utf8');
  } catch (err) {
    // Adding an account logs success before this runs, so without the line the
    // log says the account was added and it is gone after a restart.
    log.error('accounts.json could not be written; this change will not survive:', err);
  }
}

export function createNewAccount(name: string, color: string): AccountConfig {
  const id = newAccountId();
  const partition = `persist:magimail_${id}`;
  return {
    id,
    name,
    partition,
    color,
    unreadCount: 0,
  };
}
