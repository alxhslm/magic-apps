import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The three things `accounts.ts` reaches for that decide where an account file lives. A
// demo run is the case where they disagree: userData points at the demo profile while the
// App Group still points at the real install's container.
const state = vi.hoisted(() => ({
  demo: false,
  group: null as string | null,
  userData: '',
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => state.userData) },
}));

vi.mock('@magimail/core', () => ({
  isDemoMode: () => state.demo,
}));

vi.mock('../src/native-widgets.js', () => ({
  appGroupContainerPath: () => state.group,
}));

const { loadAccounts, saveAccounts } = await import('../src/accounts.js');

function writeAccounts(file: string, name: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify([
      { id: `account_${name}`, name, partition: `persist:magical_${name}`, color: '#a855f7' },
    ]),
  );
}

function accountName(file: string): string {
  return JSON.parse(fs.readFileSync(file, 'utf8'))[0].name;
}

describe('demo mode keeps clear of the App Group', () => {
  let root: string;
  let group: string;
  let userData: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'magical-demo-'));
    group = path.join(root, 'group');
    userData = path.join(root, 'profile');
    state.demo = false;
    state.group = group;
    state.userData = userData;
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the group container on an ordinary run', () => {
    writeAccounts(path.join(group, 'accounts.json'), 'Real');
    writeAccounts(path.join(userData, 'accounts.json'), 'Demo');

    expect(loadAccounts().map((account) => account.name)).toEqual(['Real']);
  });

  it('reads the profile, not the group, in demo mode', () => {
    state.demo = true;
    writeAccounts(path.join(group, 'accounts.json'), 'Real');
    writeAccounts(path.join(userData, 'accounts.json'), 'Demo');

    expect(loadAccounts().map((account) => account.name)).toEqual(['Demo']);
  });

  it('writes the profile, not the group, in demo mode', () => {
    state.demo = true;
    writeAccounts(path.join(group, 'accounts.json'), 'Real');

    saveAccounts([
      { id: 'account_demo', name: 'Demo', partition: 'persist:magical_demo', color: '#3b82f6' },
    ]);

    expect(accountName(path.join(group, 'accounts.json'))).toBe('Real');
    expect(accountName(path.join(userData, 'accounts.json'))).toBe('Demo');
  });
});
