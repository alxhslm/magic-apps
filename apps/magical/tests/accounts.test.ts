import { describe, it, expect, vi } from 'vitest';

// The module imports `app` to locate userData. Mocked so the suite never
// resolves the real Electron binary — these are pure-function tests.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/magical-test-accounts') },
}));

const { ACCOUNT_COLORS, DEFAULT_ACCOUNTS, createAccount } = await import('../src/accounts.js');

describe('accounts', () => {
  it('partitions every account under its own magical prefix', () => {
    // Sharing a partition with Magimail would put two apps on one Chromium
    // profile directory and collide on its SQLite locks.
    for (const account of DEFAULT_ACCOUNTS) {
      expect(account.partition.startsWith('persist:magical_')).toBe(true);
    }
    const created = createAccount('Work', DEFAULT_ACCOUNTS);
    expect(created.partition.startsWith('persist:magical_')).toBe(true);
    expect(created.partition).toContain(created.id);
  });

  it('gives each new account the next unused colour', () => {
    const accounts = [...DEFAULT_ACCOUNTS];
    accounts.push(createAccount('Work', accounts));
    accounts.push(createAccount('Side', accounts));
    expect(accounts.map((a) => a.color)).toEqual([
      ACCOUNT_COLORS[0],
      ACCOUNT_COLORS[1],
      ACCOUNT_COLORS[2],
    ]);
  });

  it('wraps the colour list rather than running out', () => {
    const filler = Array.from({ length: ACCOUNT_COLORS.length }, (_, i) => ({
      id: `a${i}`,
      name: `a${i}`,
      partition: `persist:magical_a${i}`,
      color: ACCOUNT_COLORS[i],
    }));
    expect(createAccount('Overflow', filler).color).toBe(ACCOUNT_COLORS[0]);
  });

  it('never reuses an id within a run', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createAccount('x', DEFAULT_ACCOUNTS).id));
    expect(ids.size).toBe(50);
  });
});
