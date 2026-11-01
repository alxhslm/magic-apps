import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { isDemoMode, newAccountId } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { appGroupContainerPath } from './native-widgets.js';

const log = createLogger('Accounts');

/**
 * Magical's accounts are stored and partitioned exactly as Magimail's are, but
 * in their own file and under their own `persist:magical_*` prefix. Sharing a
 * partition with Magimail would put two apps on one Chromium profile directory
 * and collide on its SQLite locks.
 */
export interface CalendarMeta {
  id: string;
  name: string;
  color: string;
  /**
   * The notifications this calendar applies to an event that sets none of its own, in
   * minutes before the start.
   *
   * Absent until the account's view has been served a full sync, which is the only place
   * this is stated; see `calendar-list.ts`.
   */
  defaultReminderMinutes?: number[];
}

export interface CalendarAccount {
  id: string;
  name: string;
  partition: string;
  /** Dot colour in the drawer and, later, the toolbar's account switcher. */
  color: string;
  email?: string;
  /**
   * Calendars this account owns, as observed from its own Google Calendar view.
   *
   * Persisted because the range endpoint will not infer them from the session, and the
   * account's view has to be loaded to learn them — without this the poller could not
   * run until the user next opened the account. Order carries no meaning; see
   * `calendar-identity.ts`.
   */
  calendarIds?: string[];
  /**
   * Discovered calendar metadata (authentic names, colors, and visibility flags)
   * extracted from Google Calendar.
   */
  calendars?: CalendarMeta[];
  /** Obfuscated Gaia ID learned from the account's Google Calendar view. */
  gaiaId?: string;
  /**
   * Google's public browser API key, learned from the account's Calendar view and used on
   * the Tasks sync. Not a Magic Apps secret; see `docs/magical/google-tasks.md`.
   */
  apiKey?: string;
  /** Target browser for external and meeting links. 'system' or specific browser id. */
  browser?: string;
  /** Target profile directory for Chromium browsers, or '_auto' to match by account email. */
  browserProfile?: string;
}

const ACCOUNTS_FILENAME = 'accounts.json';

export const DEFAULT_ACCOUNTS: CalendarAccount[] = [
  {
    id: 'account_personal',
    name: 'Personal',
    partition: 'persist:magical_personal',
    color: '#a855f7',
  },
];

/** Cycled through as accounts are added, so two accounts never share a dot. */
export const ACCOUNT_COLORS = [
  '#a855f7',
  '#3b82f6',
  '#22c55e',
  '#f97316',
  '#ec4899',
  '#14b8a6',
] as const;

/**
 * The App Group container accounts are stored in, or null when this run must keep to
 * userData instead.
 *
 * A demo never reaches into the group. Its accounts are invented, and the group's are the
 * real install's: a `--profile` redirects userData but not the container, which is keyed to
 * the bundle id and its signature, so without this every demo would show the real accounts.
 */
function accountsGroupContainer(): string | null {
  return isDemoMode() ? null : appGroupContainerPath();
}

/**
 * Where the App Intents extension reads the account list for the Focus Filter
 * picker.
 *
 * In the App Group container, which the app and the extension are both entitled
 * for. Application Support is only the pre-group fallback, for a build whose
 * signature carries no group, and is where a demo run keeps its invented accounts.
 */
function accountsPath(): string {
  const group = accountsGroupContainer();
  if (group) return path.join(group, ACCOUNTS_FILENAME);
  return legacyAccountsPath();
}

/** The pre-group location, read once to migrate an existing install. */
function legacyAccountsPath(): string {
  const userData =
    typeof app?.getPath === 'function' ? app.getPath('userData') : '/tmp/magical-accounts';
  return path.join(userData, ACCOUNTS_FILENAME);
}

/** Parses one accounts file, or null when it is absent, empty or unreadable. */
function readAccountsFile(file: string): CalendarAccount[] | null {
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data) && data.length > 0) return data;
    }
  } catch (err) {
    // The user's configured accounts are then replaced by a single default,
    // which is indistinguishable from a fresh install.
    log.error('accounts.json could not be read; falling back to the defaults:', err);
  }
  return null;
}

export function loadAccounts(): CalendarAccount[] {
  const group = accountsGroupContainer();
  if (group) {
    const primary = path.join(group, ACCOUNTS_FILENAME);
    const fromGroup = readAccountsFile(primary);
    if (fromGroup) return fromGroup;
    // First run with the group: copy the old file into the group so the Focus
    // Filter picker is not empty until the user next changes an account.
    const fromLegacy = readAccountsFile(legacyAccountsPath());
    if (fromLegacy) {
      try {
        fs.writeFileSync(primary, JSON.stringify(fromLegacy, null, 2), 'utf8');
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

export function saveAccounts(accounts: CalendarAccount[]): void {
  try {
    const file = accountsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(accounts, null, 2), 'utf8');
  } catch (err) {
    log.error('accounts.json could not be written; this change will not survive:', err);
  }
}

/**
 * The first colour nothing is using.
 *
 * By what is taken rather than by how many exist: indexing on `length` hands a
 * new account the colour of one just removed, so adding an account after a
 * deletion produces two rows the same.
 */
export function nextAccountColor(existing: CalendarAccount[]): string {
  const used = new Set(existing.map((a) => a.color));
  return (
    ACCOUNT_COLORS.find((c) => !used.has(c)) ??
    ACCOUNT_COLORS[existing.length % ACCOUNT_COLORS.length]
  );
}

export function createAccount(name: string, existing: CalendarAccount[]): CalendarAccount {
  const id = newAccountId();
  return {
    id,
    name,
    partition: `persist:magical_${id}`,
    color: nextAccountColor(existing),
  };
}
