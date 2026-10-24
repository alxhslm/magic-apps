import { describe, it, expect, vi } from 'vitest';
import type { WebContentsView } from 'electron';
import {
  toThreadReference,
  buildSyncPayload,
  syncEndpoint,
  SyncThreadActionDriver,
  FallbackThreadActionDriver,
  createDefaultThreadActionDriver,
  type ThreadActionDriver,
} from '../src/thread-actions/index.js';
import { setGmailSyncStateForTest } from '../src/gmail-sync-state.js';

const PARTITION = 'persist:magimail_personal';
const THREAD_HEX = '1a00000000000002';

describe('toThreadReference', () => {
  it('converts a 16-hex Atom feed ID to decimal thread and message refs', () => {
    // Example: 0x1a00000000000002 -> 1873497444986126338
    const refs = toThreadReference('1a00000000000002');
    expect(refs).toEqual({
      threadRef: 'thread-f:1873497444986126338',
      msgRef: 'msg-f:1873497444986126338',
    });
  });

  it('handles uppercase hexadecimal IDs', () => {
    const refs = toThreadReference('1A00000000000002');
    expect(refs).toEqual({
      threadRef: 'thread-f:1873497444986126338',
      msgRef: 'msg-f:1873497444986126338',
    });
  });

  it('accepts direct decimal thread strings', () => {
    const refs = toThreadReference('1873497444986126338');
    expect(refs).toEqual({
      threadRef: 'thread-f:1873497444986126338',
      msgRef: 'msg-f:1873497444986126338',
    });
  });

  it('accepts already-formatted thread references', () => {
    const refs = toThreadReference('thread-f:1873497444986126338');
    expect(refs).toEqual({
      threadRef: 'thread-f:1873497444986126338',
      msgRef: 'msg-f:1873497444986126338',
    });
  });

  it('accepts alternative thread types like thread-a', () => {
    const refs = toThreadReference('thread-a:1873497444986126338');
    expect(refs).toEqual({
      threadRef: 'thread-a:1873497444986126338',
      msgRef: 'msg-a:1873497444986126338',
    });
  });

  it('returns null for invalid or empty IDs', () => {
    expect(toThreadReference('')).toBeNull();
    expect(toThreadReference('   ')).toBeNull();
    expect(toThreadReference('invalid-id-xyz')).toBeNull();
    expect(toThreadReference('123')).toBeNull();
  });
});

describe('buildSyncPayload', () => {
  const threadRef = 'thread-f:1873497444986126338';
  const msgRef = 'msg-f:1873497444986126338';
  const json = (action: Parameters<typeof buildSyncPayload>[0]) =>
    JSON.stringify(buildSyncPayload(action, threadRef, msgRef));

  it('removes the Inbox label for archive, in the slot markRead removes from', () => {
    // Command 1414 removes labels, and a removal belongs in the second slot.
    expect(json('archive')).toContain(
      `[1414,["${threadRef}",[null,null,null,null,null,null,[null,["^i"],["${msgRef}"]]]]]`,
    );
    expect(json('markRead')).toContain(
      `[1414,["${threadRef}",[null,null,null,null,null,null,[null,["^u","^us"],["${msgRef}"]]]]]`,
    );
  });

  it('adds the labels trash and mark unread carry', () => {
    expect(json('trash')).toContain(
      `[1413,["${threadRef}",[null,null,null,null,null,null,[["^k"],null,["${msgRef}"]]]]]`,
    );
    expect(json('markUnread')).toContain(
      `[1413,["${threadRef}",[null,null,null,null,null,null,[["^u"],null,["${msgRef}"]]]]]`,
    );
  });

  it('returns null for an action with no mutation', () => {
    expect(buildSyncPayload('open' as never, threadRef, msgRef)).toBeNull();
  });
});

describe('FallbackThreadActionDriver', () => {
  const mockView = {} as unknown as WebContentsView;

  it('returns true from the sync driver and never calls the fallback', async () => {
    const mockSync: ThreadActionDriver = { perform: vi.fn().mockResolvedValue(true) };
    const mockDom: ThreadActionDriver = { perform: vi.fn().mockResolvedValue(true) };

    const fallback = new FallbackThreadActionDriver(mockSync, mockDom);
    const result = await fallback.perform(mockView, 'account_personal', THREAD_HEX, 'archive');

    expect(result).toBe(true);
    expect(mockSync.perform).toHaveBeenCalledWith(
      mockView,
      'account_personal',
      THREAD_HEX,
      'archive',
    );
    expect(mockDom.perform).not.toHaveBeenCalled();
  });

  it('falls back to the DOM driver when the sync driver returns false', async () => {
    const mockSync: ThreadActionDriver = { perform: vi.fn().mockResolvedValue(false) };
    const mockDom: ThreadActionDriver = { perform: vi.fn().mockResolvedValue(true) };

    const fallback = new FallbackThreadActionDriver(mockSync, mockDom);
    const result = await fallback.perform(mockView, 'account_personal', THREAD_HEX, 'trash');

    expect(result).toBe(true);
    expect(mockDom.perform).toHaveBeenCalledWith(mockView, 'account_personal', THREAD_HEX, 'trash');
  });

  it('falls back to the DOM driver when the sync driver throws', async () => {
    const mockSync: ThreadActionDriver = {
      perform: vi.fn().mockRejectedValue(new Error('Network error')),
    };
    const mockDom: ThreadActionDriver = { perform: vi.fn().mockResolvedValue(true) };

    const fallback = new FallbackThreadActionDriver(mockSync, mockDom);
    const result = await fallback.perform(undefined, 'account_personal', THREAD_HEX, 'markRead');

    expect(result).toBe(true);
    expect(mockDom.perform).toHaveBeenCalledWith(
      undefined,
      'account_personal',
      THREAD_HEX,
      'markRead',
    );
  });

  it('returns false when both drivers fail', async () => {
    const mockSync: ThreadActionDriver = { perform: vi.fn().mockResolvedValue(false) };
    const mockDom: ThreadActionDriver = { perform: vi.fn().mockResolvedValue(false) };

    const fallback = new FallbackThreadActionDriver(mockSync, mockDom);
    const result = await fallback.perform(mockView, 'account_personal', THREAD_HEX, 'markUnread');
    expect(result).toBe(false);
  });
});

describe('SyncThreadActionDriver', () => {
  function fakeView() {
    const scripts: string[] = [];
    const view = {
      webContents: {
        isDestroyed: () => false,
        executeJavaScript: vi.fn(async (script: string) => {
          scripts.push(script);
          return true;
        }),
      },
    } as unknown as WebContentsView;
    return { view, scripts };
  }

  it('returns false when the thread id cannot be resolved, without fetching', async () => {
    const fetchImpl = vi.fn();
    const driver = new SyncThreadActionDriver({
      getAccountContext: () => ({ partition: PARTITION }),
      fetchImpl,
    });

    const result = await driver.perform(undefined, 'account_personal', 'invalid', 'archive');
    expect(result).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns false when the account is unknown', async () => {
    const fetchImpl = vi.fn();
    const driver = new SyncThreadActionDriver({
      getAccountContext: () => undefined,
      fetchImpl,
    });

    const result = await driver.perform(undefined, 'account_personal', THREAD_HEX, 'archive');
    expect(result).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns false when no /sync/ capture exists for the partition', async () => {
    const fetchImpl = vi.fn();
    const driver = new SyncThreadActionDriver({
      getAccountContext: () => ({ partition: PARTITION }),
      fetchImpl,
    });

    const result = await driver.perform(undefined, 'account_personal', THREAD_HEX, 'archive');
    expect(result).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts from the main process with captured headers and no view, then refreshes', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }));
    const { view, scripts } = fakeView();
    const driver = new SyncThreadActionDriver({
      getAccountContext: () => ({ partition: PARTITION }),
      existingView: () => view,
      fetchImpl,
    });

    setGmailSyncStateForTest(PARTITION, {
      accountIndex: '0',
      headers: { 'X-Framework-Xsrf-Token': 'token', Origin: 'https://mail.google.com' },
      capturedAt: Date.now(),
    });

    const ok = await driver.perform(undefined, 'account_personal', THREAD_HEX, 'archive');
    expect(ok).toBe(true);

    const [partition, url, init] = fetchImpl.mock.calls[0];
    expect(partition).toBe(PARTITION);
    expect(url).toBe(syncEndpoint('0'));
    expect(init.method).toBe('POST');
    expect(init.headers['X-Framework-Xsrf-Token']).toBe('token');
    expect(init.headers['Content-Type']).toBe('application/json');

    // The page re-renders only; it never makes the request, and the helper is scoped so
    // a second press does not redeclare it.
    expect(scripts[0]).toContain('return clickRefresh()');
    expect(scripts[0]).toContain('(() => {');
    expect(scripts[0]).not.toContain('__magimailSyncHeaders');

    setGmailSyncStateForTest(PARTITION, undefined);
  });

  it('does not press a refresh when the account has no view', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }));
    const driver = new SyncThreadActionDriver({
      getAccountContext: () => ({ partition: PARTITION }),
      fetchImpl,
    });

    setGmailSyncStateForTest(PARTITION, {
      accountIndex: '2',
      headers: { 'X-Framework-Xsrf-Token': 'token' },
      capturedAt: Date.now(),
    });

    const ok = await driver.perform(undefined, 'account_personal', THREAD_HEX, 'markRead');
    expect(ok).toBe(true);
    expect(fetchImpl.mock.calls[0][1]).toBe(syncEndpoint('2'));

    setGmailSyncStateForTest(PARTITION, undefined);
  });

  it('returns false when the direct write is refused, so the DOM driver can act', async () => {
    const fetchImpl = vi.fn(async () => new Response('["er","x"]', { status: 403 }));
    const driver = new SyncThreadActionDriver({
      getAccountContext: () => ({ partition: PARTITION }),
      fetchImpl,
    });

    setGmailSyncStateForTest(PARTITION, {
      accountIndex: '0',
      headers: { 'X-Framework-Xsrf-Token': 'stale' },
      capturedAt: Date.now(),
    });

    const ok = await driver.perform(undefined, 'account_personal', THREAD_HEX, 'archive');
    expect(ok).toBe(false);

    setGmailSyncStateForTest(PARTITION, undefined);
  });
});

describe('createDefaultThreadActionDriver factory', () => {
  it('returns a FallbackThreadActionDriver instance', () => {
    const driver = createDefaultThreadActionDriver(
      { wake: async () => undefined },
      { getAccountContext: () => undefined },
    );
    expect(driver).toBeInstanceOf(FallbackThreadActionDriver);
  });
});
