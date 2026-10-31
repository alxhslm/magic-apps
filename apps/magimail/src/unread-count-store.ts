import { app } from 'electron';
import path from 'node:path';
import { type AccountConfig, readSecretFile, writeSecretFile } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('UnreadCounts');

const COUNTS_FILENAME = 'unread-counts.json';

/** The two counts a launch starts from, per account. */
export interface StoredUnreadCounts {
  /** Everything unread, for the menu bar, tray and widgets. */
  total: number;
  /** Categories not silenced, for the dock badge. */
  badge: number;
}

/**
 * Where the last known counts are kept between launches.
 *
 * Sealed through `secret-file`, which encrypts on a packaged build, because this
 * is user data. It is a separate file rather than fields in `accounts.json`
 * because that one is shared with the App Intents extension, which reads the
 * account list for the Focus Filter picker and cannot decrypt; keeping the counts
 * out of it means the shared file carries no more than the account list.
 */
function countsPath(): string {
  const userData =
    typeof app?.getPath === 'function' ? app.getPath('userData') : '/tmp/magimail-unread-counts';
  return path.join(userData, COUNTS_FILENAME);
}

/** The counts from the last launch, or an empty map when there are none. */
export function loadUnreadCounts(): Record<string, StoredUnreadCounts> {
  try {
    const stored = readSecretFile<Record<string, StoredUnreadCounts>>(countsPath());
    return stored && typeof stored === 'object' ? stored : {};
  } catch (err) {
    // A file that will not decrypt is damage, not absence. The tray starts from
    // the account file's own counts and corrects on the first observation, which
    // is a stale number rather than a lost one.
    log.warn('Could not read the stored unread counts; starting from the accounts file:', err);
    return {};
  }
}

export function saveUnreadCounts(counts: Record<string, StoredUnreadCounts>): void {
  try {
    writeSecretFile(countsPath(), counts);
  } catch (err) {
    // Only a launch that starts at zero depends on this, so it is not worth
    // failing anything over.
    log.warn('Could not store the unread counts:', err);
  }
}

/**
 * The accounts, with the counts from the last launch applied.
 *
 * Startup draws the tray from the account list before anything is polled, so
 * without this every launch begins at zero until the first cache read answers.
 */
export function withStoredUnreadCounts(accounts: AccountConfig[]): AccountConfig[] {
  const stored = loadUnreadCounts();
  return accounts.map((account) => {
    const counts = stored[account.id];
    if (!counts) return account;
    return { ...account, unreadCount: counts.total, badgeUnreadCount: counts.badge };
  });
}
