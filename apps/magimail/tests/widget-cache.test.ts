import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AccountConfig } from '@magimail/core';
import type { TrayMessageItem } from '../src/menubar-manager.js';

vi.mock('@magimail/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  redactText: (s: string) => s,
}));

const { buildWidgetCache, writeWidgetCache, resetWidgetCachePath, resetWidgetCacheContent } =
  await import('../src/widget-cache.js');
type WidgetCache = import('../src/widget-cache.js').WidgetCache;

/**
 * WidgetKit rations reloads per widget, and Magimail asked for one on every
 * poll and every unread change — thousands a day against a mailbox that mostly
 * had not moved. These cover the guard that replaced it: the snapshot is only
 * rewritten, and the timelines only reloaded, when what a widget draws changed.
 * What the widget draws excludes `updatedAt`, which is a fresh timestamp on
 * every build and would otherwise make every poll look different.
 */

let tmp: string;

beforeEach(() => {
  resetWidgetCachePath();
  resetWidgetCacheContent();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magimail-content-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  resetWidgetCachePath();
  resetWidgetCacheContent();
});

function account(overrides: Partial<WidgetCache['accounts'][number]> = {}) {
  return {
    id: 'a1',
    name: 'Work',
    color: '#039be5',
    email: 'me@work.com',
    unreadCount: 3,
    ...overrides,
  };
}

function message(overrides: Partial<WidgetCache['messages'][number]> = {}) {
  return {
    id: 'm1',
    threadId: 't1',
    accountId: 'a1',
    sender: 'Ada',
    subject: 'Standup notes',
    snippet: 'Here are the notes',
    date: 1_700_000_000_000,
    category: 'primary',
    unread: true,
    ...overrides,
  };
}

/** An account as `loadAccounts` hands it to `buildWidgetCache`. */
function accountConfig(overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id: 'a1',
    name: 'Work',
    partition: 'persist:magimail_work',
    color: '#039be5',
    unreadCount: 3,
    email: 'me@work.com',
    ...overrides,
  };
}

/** A thread as the Gmail cache reader hands it over. */
function trayMessage(overrides: Partial<TrayMessageItem> = {}): TrayMessageItem {
  return {
    id: 'm1',
    threadId: 't1',
    from: 'Ada Lovelace <ada@example.com>',
    subject: 'Standup notes',
    snippet: 'Here are the notes',
    modified: new Date(1_700_000_000_000),
    category: 'primary',
    unread: true,
    ...overrides,
  };
}

function cache(overrides: Partial<WidgetCache> = {}): WidgetCache {
  return {
    updatedAt: 1,
    totalUnread: 3,
    accounts: [account()],
    messages: [message()],
    ...overrides,
  };
}

describe('writeWidgetCache', () => {
  it('writes nothing when there is no App Group container', () => {
    expect(writeWidgetCache(cache(), () => null)).toBe(false);
  });

  it('writes on the first snapshot and says so', () => {
    expect(writeWidgetCache(cache(), () => tmp)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'widget-cache.json'))).toBe(true);
  });

  it('does not rewrite when only the poll time moved', () => {
    const resolve = () => tmp;
    expect(writeWidgetCache(cache(), resolve)).toBe(true);
    expect(writeWidgetCache(cache({ updatedAt: 2_000_000 }), resolve)).toBe(false);
  });

  it('leaves the file untouched when the snapshot is unchanged', () => {
    // The poller runs on its own schedule and on every unread hint. A repeat
    // with the same drawn content must not touch the file, let alone the
    // timelines.
    const resolve = () => tmp;
    writeWidgetCache(cache(), resolve);
    const before = readFileSync(path.join(tmp, 'widget-cache.json'), 'utf8');

    expect(writeWidgetCache(cache({ updatedAt: 999 }), resolve)).toBe(false);
    expect(readFileSync(path.join(tmp, 'widget-cache.json'), 'utf8')).toBe(before);
  });

  it('rewrites when a message arrived', () => {
    const resolve = () => tmp;
    writeWidgetCache(cache(), resolve);

    expect(
      writeWidgetCache(
        cache({
          totalUnread: 4,
          accounts: [account({ unreadCount: 4 })],
          messages: [message({ id: 'm2', subject: 'New one' }), message()],
        }),
        resolve,
      ),
    ).toBe(true);
  });

  it('rewrites when an account was added or renamed', () => {
    const resolve = () => tmp;
    writeWidgetCache(cache(), resolve);

    expect(writeWidgetCache(cache({ accounts: [account({ name: 'Personal' })] }), resolve)).toBe(
      true,
    );
  });

  it('rewrites when a thread was read', () => {
    // The widget draws read and unread differently, so a thread leaving the
    // feed has to reach it: the guard keys on what a widget draws.
    const resolve = () => tmp;
    writeWidgetCache(cache(), resolve);

    expect(writeWidgetCache(cache({ messages: [message({ unread: false })] }), resolve)).toBe(true);
  });

  it('does not throw when the destination is unwritable, and says nothing was written', () => {
    let wrote: boolean | undefined;
    expect(() => {
      wrote = writeWidgetCache(cache(), () => '/dev/null/nope');
    }).not.toThrow();
    expect(wrote).toBe(false);
  });
});

/**
 * What the snapshot itself carries. The popover and the widget read the same
 * threads, so a field the widget draws has to survive this build.
 */
describe('buildWidgetCache', () => {
  it('carries the feed’s unread flag into the snapshot', () => {
    const snapshot = buildWidgetCache(
      [accountConfig()],
      1,
      new Map([
        [
          'a1',
          [
            trayMessage({ id: 'unread', modified: new Date(1_700_000_000_000), unread: true }),
            trayMessage({ id: 'read', modified: new Date(1_699_000_000_000), unread: false }),
          ],
        ],
      ]),
    );

    expect(snapshot.messages.map((m) => [m.id, m.unread])).toEqual([
      ['unread', true],
      ['read', false],
    ]);
  });

  it('counts a message with no unread flag as unread, as the popover does', () => {
    const snapshot = buildWidgetCache(
      [accountConfig()],
      1,
      new Map([['a1', [trayMessage({ unread: undefined })]]]),
    );

    expect(snapshot.messages[0].unread).toBe(true);
  });
});

/**
 * The reload guard lives in `main.ts`, which cannot be imported in a test — it
 * pulls in Electron and starts an app. Assert the call site agrees with
 * `writeWidgetCache`'s return value instead, the way the other cross-file
 * contracts in this suite do.
 */
describe('the timeline reload contract', () => {
  const main = readFileSync(path.resolve(__dirname, '../src/main.ts'), 'utf8');

  it('reloads only a snapshot that was actually written', () => {
    expect(main, 'refreshWidgetCache reloads unconditionally again').toMatch(
      /if\s*\(\s*wrote\s*\)\s*reloadNativeWidgets\(\)/,
    );
    expect(main, 'refreshWidgetCache ignored writeWidgetCache’s result').toContain(
      'const wrote = writeWidgetCache(',
    );
  });
});
