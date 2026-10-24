/**
 * Multi-account configuration and aggregation utilities
 */

export interface AccountConfig {
  id: string;
  name: string;
  partition: string;
  color: string; // Hex color for dot badge (e.g. #3b82f6)
  unreadCount: number;
  email?: string;
  /** Whether this account requires authentication / re-signing in */
  needsAuth?: boolean;
}

export const DEFAULT_ACCOUNTS: AccountConfig[] = [
  {
    id: 'account_personal',
    name: 'Personal',
    partition: 'persist:magimail_personal',
    color: '#a855f7', // Purple
    unreadCount: 0,
  },
];

/**
 * A new account's id.
 *
 * A random uuid, not `<timestamp>_<counter>`. The counter starts at zero each launch, so
 * two accounts added in the same millisecond after a restart collide, and it is reused
 * after a deletion; the two apps could also mint the same value for different accounts.
 * A uuid needs no coordination, carries neither the created time nor the order, and is
 * unique across both apps. The `account_` prefix stays so nothing has to parse it.
 *
 * Accounts already on disk keep the id they were saved with.
 */
export function newAccountId(): string {
  return `account_${globalThis.crypto.randomUUID()}`;
}

/**
 * Calculates total aggregate unread email count across all account partitions
 */
export function calculateAggregateUnread(accounts: AccountConfig[]): number {
  return accounts.reduce((total, acc) => total + (acc.unreadCount > 0 ? acc.unreadCount : 0), 0);
}

/**
 * Updates unread count for a specific account and returns new list
 */
export function updateAccountUnread(
  accounts: AccountConfig[],
  accountId: string,
  unreadCount: number,
): AccountConfig[] {
  return accounts.map((acc) =>
    acc.id === accountId ? { ...acc, unreadCount: Math.max(0, unreadCount) } : acc,
  );
}

/**
 * Updates authentication-required status for a specific account and returns new list
 */
export function updateAccountAuth(
  accounts: AccountConfig[],
  accountId: string,
  needsAuth: boolean,
): AccountConfig[] {
  return accounts.map((acc) => (acc.id === accountId ? { ...acc, needsAuth } : acc));
}
