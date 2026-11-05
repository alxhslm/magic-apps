import { describe, it, expect, vi } from 'vitest';
import { isAccountEmail, readAccountEmail } from '../src/account-email.js';

describe('isAccountEmail', () => {
  it('accepts the addresses Google signs an account in with', () => {
    expect(isAccountEmail('alex@corp.com')).toBe(true);
    expect(isAccountEmail('alex.haslam+mail@mail.example.co.uk')).toBe(true);
    expect(isAccountEmail('  alex@corp.com  ')).toBe(true);
  });

  it('rejects what a half-rendered chip or a display name would produce', () => {
    expect(isAccountEmail('')).toBe(false);
    expect(isAccountEmail('Alex Haslam')).toBe(false);
    expect(isAccountEmail('@corp.com')).toBe(false);
    expect(isAccountEmail('alex@')).toBe(false);
    expect(isAccountEmail('alex@corp')).toBe(false);
    expect(isAccountEmail('alex@corp.com (work)')).toBe(false);
    expect(isAccountEmail(undefined)).toBe(false);
    expect(isAccountEmail(42)).toBe(false);
  });
});

describe('readAccountEmail', () => {
  const noWait = () => Promise.resolve();

  it('returns the address once the page shows one', async () => {
    const reads = ['', '', 'alex@corp.com'];
    const email = await readAccountEmail({
      read: () => Promise.resolve(reads.shift()),
      sleep: noWait,
    });
    expect(email).toBe('alex@corp.com');
  });

  it('trims what the page returns', async () => {
    const email = await readAccountEmail({
      read: () => Promise.resolve('  alex@corp.com\n'),
      sleep: noWait,
    });
    expect(email).toBe('alex@corp.com');
  });

  it('gives up after the last attempt rather than retrying forever', async () => {
    const read = vi.fn().mockResolvedValue('');
    const sleep = vi.fn().mockResolvedValue(undefined);

    const email = await readAccountEmail({ read, sleep, attempts: 3 });

    expect(email).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
    // No trailing wait after the last look, so nothing is left running.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('keeps looking when a read throws, which is what a navigation mid-script does', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('Script failed to execute'))
      .mockResolvedValue('alex@corp.com');

    const email = await readAccountEmail({ read, sleep: noWait });

    expect(email).toBe('alex@corp.com');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('stops when the page goes away', async () => {
    const read = vi.fn().mockResolvedValue('');
    let alive = true;

    const promise = readAccountEmail({
      read,
      isAlive: () => alive,
      sleep: async () => {
        alive = false;
      },
      attempts: 4,
    });

    expect(await promise).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('returns null for a page that answers with something that is not an address', async () => {
    const email = await readAccountEmail({
      read: () => Promise.resolve('Google Account: Alex Haslam'),
      sleep: noWait,
      attempts: 1,
    });
    expect(email).toBeNull();
  });
});
