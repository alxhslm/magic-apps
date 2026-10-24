import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ACCOUNTS,
  calculateAggregateUnread,
  newAccountId,
  updateAccountUnread,
  updateAccountAuth,
  type AccountConfig,
} from '../src/account.js';

describe('Multi-Account Utilities', () => {
  it('provides default Personal account config', () => {
    expect(DEFAULT_ACCOUNTS.length).toBe(1);
    expect(DEFAULT_ACCOUNTS[0].name).toBe('Personal');
    expect(DEFAULT_ACCOUNTS[0].partition).toBe('persist:magimail_personal');
  });

  it('mints each new account a unique opaque id', () => {
    const a = newAccountId();
    const b = newAccountId();
    expect(a).not.toBe(b);
    // `account_` plus a uuid: no timestamp, no counter, so a deletion or a restart
    // cannot hand a later account an id an earlier one had.
    expect(a).toMatch(/^account_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('calculates aggregate unread email count accurately', () => {
    const testAccounts: AccountConfig[] = [
      { id: 'acc_1', name: 'Work', partition: 'p1', color: '#3b82f6', unreadCount: 5 },
      { id: 'acc_2', name: 'Personal', partition: 'p2', color: '#a855f7', unreadCount: 2 },
      { id: 'acc_3', name: 'Side Project', partition: 'p3', color: '#10b981', unreadCount: 0 },
    ];

    expect(calculateAggregateUnread(testAccounts)).toBe(7);
  });

  it('handles empty or zero unread accounts', () => {
    expect(calculateAggregateUnread([])).toBe(0);
    expect(calculateAggregateUnread(DEFAULT_ACCOUNTS)).toBe(0);
  });

  it('updates unread count for specific account', () => {
    const accounts: AccountConfig[] = [
      { id: 'acc_1', name: 'Personal', partition: 'p1', color: '#a855f7', unreadCount: 0 },
      { id: 'acc_2', name: 'Work', partition: 'p2', color: '#3b82f6', unreadCount: 0 },
    ];
    const updated = updateAccountUnread(accounts, 'acc_2', 14);
    expect(updated.find((a) => a.id === 'acc_2')?.unreadCount).toBe(14);
    expect(updated.find((a) => a.id === 'acc_1')?.unreadCount).toBe(0);
    expect(calculateAggregateUnread(updated)).toBe(14);
  });

  it('updates authentication-required status for specific account', () => {
    const accounts: AccountConfig[] = [
      { id: 'acc_1', name: 'Personal', partition: 'p1', color: '#a855f7', unreadCount: 0 },
      { id: 'acc_2', name: 'Work', partition: 'p2', color: '#3b82f6', unreadCount: 0 },
    ];
    const updated = updateAccountAuth(accounts, 'acc_2', true);
    expect(updated.find((a) => a.id === 'acc_2')?.needsAuth).toBe(true);
    expect(updated.find((a) => a.id === 'acc_1')?.needsAuth).toBeUndefined();

    const cleared = updateAccountAuth(updated, 'acc_2', false);
    expect(cleared.find((a) => a.id === 'acc_2')?.needsAuth).toBe(false);
  });
});
