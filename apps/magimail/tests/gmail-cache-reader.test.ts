import { describe, it, expect, vi, afterEach } from 'vitest';
import type { WebContents } from 'electron';

vi.mock('@magimail/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  redactText: (s: string) => s,
}));

const { readRecentCachedMessages, readCachedInboxData, buildInjectedScript } =
  await import('../src/gmail-cache-reader.js');

/**
 * The menu bar and the widget read recent threads from Gmail's own IndexedDB
 * cache rather than the Atom feed's synthetic recent list — the feed drops a
 * thread the moment it is read, so it could never tell a read thread from a
 * deleted one. These cover the reader's contract with the
 * renderer: it maps what the injected script returns, and it answers with an
 * empty list rather than throwing whenever the view cannot answer, so callers
 * need no special case.
 */

interface FakeOptions {
  destroyed?: boolean;
  loading?: boolean;
  run?: () => unknown;
}

function fakeContents(options: FakeOptions = {}): WebContents {
  return {
    isDestroyed: () => options.destroyed ?? false,
    isLoading: () => options.loading ?? false,
    executeJavaScript: async () =>
      options.run ? options.run() : { messages: [], stats: { scanned: 0, inbox: 0 } },
  } as unknown as WebContents;
}

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'atom1',
  threadId: 'atom1',
  from: 'Sender <sender@example.com>',
  subject: 'A subject',
  snippet: 'A snippet',
  timestampMs: 1_700_000_000_000,
  unread: true,
  category: 'updates',
  ...overrides,
});

const payload = (
  messages: unknown[],
  stats = { scanned: messages.length, inbox: messages.length },
) => ({
  messages,
  stats,
});

afterEach(() => {
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

describe('readRecentCachedMessages', () => {
  it('maps the renderer rows into tray items', async () => {
    const messages = await readRecentCachedMessages(
      fakeContents({ run: () => payload([row()]) }),
      20,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'atom1',
      threadId: 'atom1',
      from: 'Sender <sender@example.com>',
      subject: 'A subject',
      snippet: 'A snippet',
      category: 'updates',
      unread: true,
    });
    expect(messages[0].modified).toBeInstanceOf(Date);
    expect((messages[0].modified as Date).getTime()).toBe(1_700_000_000_000);
  });

  it('defaults every missing field rather than passing undefined through', async () => {
    const messages = await readRecentCachedMessages(
      fakeContents({
        run: () =>
          payload([
            row({
              from: undefined,
              subject: undefined,
              snippet: undefined,
              timestampMs: 0,
              unread: false,
              category: undefined,
            }),
          ]),
      }),
      20,
    );

    expect(messages[0]).toMatchObject({
      from: '',
      subject: '',
      snippet: '',
      category: 'primary',
      unread: false,
    });
    expect(messages[0].modified).toBeUndefined();
  });

  it('skips a row with no id, which could not be deep-linked or identified', async () => {
    const messages = await readRecentCachedMessages(
      fakeContents({ run: () => payload([row(), row({ id: '' })]) }),
      20,
    );

    expect(messages.map((m) => m.id)).toEqual(['atom1']);
  });

  it('returns null when the view is destroyed, so the caller keeps its list', async () => {
    const execute = vi.fn();
    const contents = { ...fakeContents({ destroyed: true }), executeJavaScript: execute };

    expect(await readRecentCachedMessages(contents as WebContents, 20)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns null while the view is still loading', async () => {
    expect(await readRecentCachedMessages(fakeContents({ loading: true }), 20)).toBeNull();
  });

  it('returns null when the injected script throws', async () => {
    const contents = fakeContents({
      run: () => {
        throw new Error('no indexedDB');
      },
    });

    expect(await readRecentCachedMessages(contents, 20)).toBeNull();
  });

  it('returns null when the renderer reports a decode error', async () => {
    expect(
      await readRecentCachedMessages(fakeContents({ run: () => ({ __error: 'blocked' }) }), 20),
    ).toBeNull();
  });

  it('returns null when the renderer answers with an unexpected shape', async () => {
    expect(await readRecentCachedMessages(fakeContents({ run: () => [row()] }), 20)).toBeNull();
  });

  it('returns null when Gmail has not created the cache database yet', async () => {
    expect(
      await readRecentCachedMessages(
        fakeContents({
          run: () => ({ messages: [], stats: { scanned: 0, inbox: 0, reason: 'no-db' } }),
        }),
        20,
      ),
    ).toBeNull();
  });

  it('returns snapshot with no-db stats and diagnostics from readCachedInboxData', async () => {
    const snapshot = await readCachedInboxData(
      fakeContents({
        run: () => ({
          messages: [],
          stats: {
            scanned: 0,
            inbox: 0,
            reason: 'no-db',
            foundDbs: ['gapi_storage', 'tasks_db'],
            href: 'https://mail.google.com/mail/u/0/#inbox',
          },
          categoryCounts: {},
          inboxUnreadTotal: 0,
        }),
      }),
      20,
    );

    expect(snapshot).not.toBeNull();
    expect(snapshot?.stats.reason).toBe('no-db');
    expect(snapshot?.stats.foundDbs).toEqual(['gapi_storage', 'tasks_db']);
    expect(snapshot?.stats.href).toBe('https://mail.google.com/mail/u/0/#inbox');
    expect(snapshot?.messages).toEqual([]);
  });

  it('surfaces the cache update time as asOf', async () => {
    const snapshot = await readCachedInboxData(
      fakeContents({
        run: () => ({ ...payload([row()]), cacheUpdatedAt: 1_700_000_005_000 }),
      }),
      20,
    );

    expect(snapshot?.asOf).toBe(1_700_000_005_000);
  });

  it('leaves asOf undefined when the cache has no update time', async () => {
    const snapshot = await readCachedInboxData(fakeContents({ run: () => payload([row()]) }), 20);

    expect(snapshot?.asOf).toBeUndefined();
  });

  it('bounds the read to the requested number of messages', async () => {
    const execute = vi.fn(async () => payload([]));
    const contents = { ...fakeContents(), executeJavaScript: execute };

    await readRecentCachedMessages(contents as WebContents, 5);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toContain('slice(0, 5)');
  });
});

/**
 * The decode runs inside the renderer as a string, so nothing else in the
 * suite exercises it. It used to abort a record at the first fixed64 field,
 * and Gmail stores one *before* the Atom id at field 28 — every row came back
 * with an empty id and was dropped, so the tray and widget were empty while
 * the unread count was correct. These build a real protobuf record and run the
 * injected script against a fake `indexedDB`.
 */
describe('injected Gmail cache decoder', () => {
  function varint(n: number): number[] {
    const out: number[] = [];
    let v = n;
    while (v > 0x7f) {
      out.push((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(v);
    return out;
  }
  const tag = (field: number, wire: number) => varint((field << 3) | wire);
  const bytesField = (field: number, bytes: number[]) => [
    ...tag(field, 2),
    ...varint(bytes.length),
    ...bytes,
  ];
  const varintField = (field: number, n: number) => [...tag(field, 0), ...varint(n)];
  const fixed64Field = (field: number, n: number) => {
    const out = [...tag(field, 1)];
    let v = n;
    for (let i = 0; i < 8; i++) {
      out.push(v & 0xff);
      v = Math.floor(v / 256);
    }
    return out;
  };
  const str = (s: string) => Array.from(new TextEncoder().encode(s));

  function record(options: { labels?: string[]; atomId?: string } = {}): Uint8Array {
    const labels = options.labels ?? ['^all', '^i', '^u'];
    const thread = [...bytesField(2, str('Subject')), ...varintField(4, 1_790_000_000_000)];
    const sender = [...bytesField(2, str('a@b.com')), ...bytesField(3, str('Sender'))];
    const message = [
      ...bytesField(1, str('msg-f:123')),
      ...bytesField(2, sender),
      ...varintField(3, 1_790_000_000_000),
      ...labels.flatMap((label) => bytesField(4, str(label))),
      // The field that used to abort the parse, before the Atom id.
      ...fixed64Field(7, 12_345),
      ...bytesField(11, str('snippet')),
      ...bytesField(28, str(options.atomId ?? '0123456789abcdef')),
    ];
    return new Uint8Array([...bytesField(1, thread), ...bytesField(2, message)]);
  }

  function runScript(rows: Array<{ d: Uint8Array }>) {
    const store = {
      getAll: () => {
        const req: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
        queueMicrotask(() => {
          req.result = rows;
          req.onsuccess?.();
        });
        return req;
      },
    };
    const db = {
      transaction: () => ({ objectStore: () => store }),
      close: () => {},
    };
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      databases: async () => [{ name: 'test_xdb' }],
      open: () => {
        const req: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
        queueMicrotask(() => {
          req.result = db;
          req.onsuccess?.();
        });
        return req;
      },
    };
    return (0, eval)(buildInjectedScript(20)) as Promise<{
      messages: Array<Record<string, unknown>>;
      stats: { scanned: number; inbox: number };
    }>;
  }

  it('reads a record whose fixed64 field precedes the Atom id', async () => {
    const result = await runScript([{ d: record() }]);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      id: '0123456789abcdef',
      threadId: '0123456789abcdef',
      subject: 'Subject',
      from: 'Sender <a@b.com>',
      snippet: 'snippet',
      unread: true,
      category: 'primary',
    });
    expect(result.stats.scanned).toBe(1);
    expect(result.stats.inbox).toBe(1);
  });

  it('drops a trashed thread but still counts the record it scanned', async () => {
    const result = await runScript([{ d: record({ labels: ['^all', '^i', '^k'] }) }]);

    expect(result.messages).toHaveLength(0);
    expect(result.stats.scanned).toBe(1);
    expect(result.stats.inbox).toBe(0);
  });

  it('counts unread inbox messages per category and excludes unread archived mail', async () => {
    // 1. Unread in inbox with ^smartlabel_notification (updates) -> counts towards updates
    const unreadUpdatesInbox = record({
      labels: ['^all', '^i', '^u', '^smartlabel_notification'],
      atomId: 'msg1',
    });
    // 2. Unread archived mail with ^smartlabel_notification -> NOT in inbox (^i missing) -> excluded!
    const unreadUpdatesArchived = record({
      labels: ['^all', '^u', '^smartlabel_notification'],
      atomId: 'msg2',
    });
    // 3. Read in inbox -> NOT unread -> excluded from unread count
    const readInbox = record({
      labels: ['^all', '^i'],
      atomId: 'msg3',
    });

    const result = await runScript([
      { d: unreadUpdatesInbox },
      { d: unreadUpdatesArchived },
      { d: readInbox },
    ]);

    expect(
      (result as unknown as { categoryCounts: Record<string, number> }).categoryCounts,
    ).toEqual({
      primary: 0,
      updates: 1,
      promotions: 0,
      social: 0,
      forums: 0,
    });
    expect((result as unknown as { inboxUnreadTotal: number }).inboxUnreadTotal).toBe(1);
    expect(result.stats.scanned).toBe(3);
    expect(result.stats.inbox).toBe(2);
  });

  it('reports reason no-db with found databases and href when the cache database is absent', async () => {
    (globalThis as { indexedDB?: unknown }).indexedDB = {
      databases: async () => [{ name: 'some_other_storage' }],
    };
    const result = (await (0, eval)(buildInjectedScript(20))) as {
      messages: unknown[];
      stats: { reason: string; foundDbs: string[]; href: string };
    };

    expect(result.stats.reason).toBe('no-db');
    expect(result.stats.foundDbs).toEqual(['some_other_storage']);
    expect(result.messages).toEqual([]);
  });
});
