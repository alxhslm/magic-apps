import type { WebContents } from 'electron';
import { createLogger } from '@magimail/core/logger';
import type { TrayMessageItem } from './menubar-manager.js';
import type { NotificationCategory } from './atom-poller.js';

const log = createLogger('GmailCacheReader');

/**
 * Reads Gmail's local IndexedDB cache (`<account>_xdb`) from inside the
 * account's renderer process and returns the most recent Inbox threads.
 *
 * The cache is Gmail's own offline data layer; it is kept synchronised by
 * Gmail's data worker and reflects the true state of every thread — including
 * read/unread, labels, and categories — without any network traffic.
 *
 * ## Protobuf layout (store `items`, field `d`)
 *
 * Top-level message:
 * - Field 1 (length-delimited): thread metadata
 *   - Field 1: thread reference string (`thread-f:…`)
 *   - Field 2: subject string
 *   - Field 4: epoch ms timestamp (varint)
 * - Field 2 (length-delimited): message details
 *   - Field 1: message reference string (`msg-f:…`)
 *   - Field 2 (length-delimited): sender sub-message
 *     - Field 2: email address
 *     - Field 3: display name
 *   - Field 4: repeated label strings (`^i` inbox, `^u` unread, `^k` trash, …)
 *   - Field 11: snippet string
 *   - Field 28: 16-hex Atom message ID (used for deep links)
 *
 * Verified against live Gmail data; see the spike notes in the session summary.
 */

/** Category label strings as Gmail stores them in the `_xdb` `items` store. */
const CATEGORY_LABELS: Record<string, NotificationCategory> = {
  '^smartlabel_personal': 'primary',
  '^smartlabel_notification': 'updates',
  '^smartlabel_unim_notification': 'updates',
  '^smartlabel_promo': 'promotions',
  '^smartlabel_social': 'social',
  '^smartlabel_group': 'forums',
};

// ---------------------------------------------------------------------------
// Protobuf decoder — pure JS, no dependencies, runs in the renderer context.
// Serialised to a string and injected via executeJavaScript.
// ---------------------------------------------------------------------------

/**
 * The script injected into the Gmail renderer.
 *
 * It is a self-contained IIFE that:
 * 1. Finds the `<account>_xdb` IndexedDB database.
 * 2. Opens the `items` object store.
 * 3. Decodes the protobuf `d` field for each row.
 * 4. Filters for Inbox (has `^i`, lacks `^k`).
 * 5. Returns a plain JSON-serialisable array sorted newest-first.
 *
 * The function body is stringified so it runs in the renderer; it must not
 * close over any variables from this module.
 */
export function buildInjectedScript(maxResults: number): string {
  return `(async () => {
    // Minimal protobuf varint / length-delimited decoder.
    function readVarint(bytes, pos) {
      let result = 0n, shift = 0n;
      while (pos < bytes.length) {
        const b = BigInt(bytes[pos++]);
        result |= (b & 0x7Fn) << shift;
        shift += 7n;
        if ((b & 0x80n) === 0n) break;
      }
      return { value: result, pos };
    }

    function readFields(bytes, start, end) {
      const fields = {};
      let pos = start;
      while (pos < end) {
        const tag = readVarint(bytes, pos);
        pos = tag.pos;
        const fieldNumber = Number(tag.value >> 3n);
        const wireType = Number(tag.value & 7n);
        if (wireType === 0) {
          const v = readVarint(bytes, pos);
          pos = v.pos;
          if (!fields[fieldNumber]) fields[fieldNumber] = [];
          fields[fieldNumber].push(v.value);
        } else if (wireType === 2) {
          const lenV = readVarint(bytes, pos);
          pos = lenV.pos;
          const len = Number(lenV.value);
          const slice = bytes.slice(pos, pos + len);
          pos += len;
          if (!fields[fieldNumber]) fields[fieldNumber] = [];
          fields[fieldNumber].push(slice);
        } else if (wireType === 1) {
          // A 64-bit fixed field. Gmail puts one here before the Atom id at field
          // 28, so skipping it keeps the rest of the record readable.
          pos += 8;
        } else if (wireType === 5) {
          pos += 4;
        } else {
          // Groups (3/4) are not used here; stop rather than guess at the shape.
          break;
        }
      }
      return fields;
    }

    function decodeString(bytes) {
      try { return new TextDecoder().decode(bytes); } catch { return ''; }
    }

    function decodeRow(bytes) {
      const top = readFields(bytes, 0, bytes.length);
      // Field 1: thread metadata
      const threadBytes = top[1]?.[0];
      if (!threadBytes) return null;
      const thread = readFields(threadBytes, 0, threadBytes.length);
      const subject = decodeString(thread[2]?.[0] ?? new Uint8Array());
      const timestampMs = thread[4]?.[0] ? Number(thread[4][0]) : 0;

      // Field 2: message details (take the first / most recent)
      const msgBytes = top[2]?.[0];
      if (!msgBytes) return null;
      const msg = readFields(msgBytes, 0, msgBytes.length);

      // Field 2 within msg: sender sub-message
      const senderBytes = msg[2]?.[0];
      let from = '';
      if (senderBytes) {
        const sender = readFields(senderBytes, 0, senderBytes.length);
        const email = decodeString(sender[2]?.[0] ?? new Uint8Array());
        const name = decodeString(sender[3]?.[0] ?? new Uint8Array());
        from = name && email ? name + ' <' + email + '>' : email || name;
      }

      // Field 4: repeated label strings
      const labels = (msg[4] ?? []).map(decodeString);

      // Field 11: snippet
      const snippet = decodeString(msg[11]?.[0] ?? new Uint8Array());

      // Field 28: 16-hex Atom message id
      const atomId = decodeString(msg[28]?.[0] ?? new Uint8Array());

      return { subject, timestampMs, from, labels, snippet, atomId };
    }

    const CATEGORY_LABELS = ${JSON.stringify(CATEGORY_LABELS)};

    function resolveCategory(labels) {
      for (const label of labels) {
        const cat = CATEGORY_LABELS[label];
        if (cat && cat !== 'primary') return cat;
      }
      return 'primary';
    }

    const categoryCounts = {
      primary: 0,
      updates: 0,
      promotions: 0,
      social: 0,
      forums: 0,
    };
    let inboxUnreadTotal = 0;

    try {
      const databases = await indexedDB.databases();
      const xdb = databases.find(d => d.name && d.name.endsWith('_xdb'));
      if (!xdb?.name) {
        return {
          messages: [],
          stats: {
            scanned: 0,
            inbox: 0,
            reason: 'no-db',
            foundDbs: databases.map(d => d.name || '').filter(Boolean),
            href: typeof location !== 'undefined' ? location.href : '',
          },
          categoryCounts,
          inboxUnreadTotal: 0,
        };
      }

      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(xdb.name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      const results = await new Promise((resolve, reject) => {
        const tx = db.transaction('items', 'readonly');
        const store = tx.objectStore('items');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      db.close();

      const messages = [];
      let scanned = 0;
      let inInbox = 0;
      for (const row of results) {
        const bytes = row.d instanceof Uint8Array
          ? row.d
          : row.d instanceof ArrayBuffer
            ? new Uint8Array(row.d)
            : null;
        if (!bytes) continue;

        const decoded = decodeRow(bytes);
        if (!decoded) continue;
        scanned += 1;

        // Must be in Inbox and not Trash.
        if (!decoded.labels.includes('^i') || decoded.labels.includes('^k')) continue;
        inInbox += 1;

        const isUnread = decoded.labels.includes('^u');
        const category = resolveCategory(decoded.labels);

        if (isUnread) {
          inboxUnreadTotal += 1;
          categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
        }

        // Must have a usable message id for deep links.
        if (!decoded.atomId) continue;

        messages.push({
          id: decoded.atomId,
          threadId: decoded.atomId,
          subject: decoded.subject,
          from: decoded.from,
          snippet: decoded.snippet,
          timestampMs: decoded.timestampMs,
          unread: isUnread,
          category,
        });
      }

      messages.sort((a, b) => b.timestampMs - a.timestampMs);
      return {
        messages: messages.slice(0, ${maxResults}),
        stats: { scanned, inbox: inInbox },
        categoryCounts,
        inboxUnreadTotal,
      };
    } catch (err) {
      return { __error: String(err) };
    }
  })()`;
}

interface RawCacheMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  timestampMs: number;
  unread: boolean;
  category: NotificationCategory;
}

export interface CachedInboxSnapshot {
  messages: TrayMessageItem[];
  categoryCounts: Map<NotificationCategory, number>;
  inboxUnreadTotal: number;
  stats: {
    scanned?: number;
    inbox?: number;
    reason?: string;
    foundDbs?: string[];
    href?: string;
  };
}

/**
 * Reads the most recent Inbox threads and inbox unread category counts
 * from Gmail's offline IndexedDB cache by running a script inside the
 * account's renderer process.
 *
 * Returns `null` — never throws — when the view cannot answer: it is
 * destroyed, still loading, or the script failed.
 *
 * When Gmail has not created its cache database (`reason: 'no-db'`), returns
 * an empty snapshot with `stats.reason === 'no-db'` so callers can diagnose
 * the missing cache or fall back.
 */
export async function readCachedInboxData(
  webContents: WebContents,
  maxResults = 20,
): Promise<CachedInboxSnapshot | null> {
  if (webContents.isDestroyed()) {
    log.warn('No cached messages: the account view is destroyed');
    return null;
  }
  if (webContents.isLoading()) {
    log.info('No cached messages yet: the account view is still loading');
    return null;
  }

  let raw: unknown;
  try {
    raw = await webContents.executeJavaScript(buildInjectedScript(maxResults), true);
  } catch (err) {
    log.warn('IndexedDB script execution failed:', err);
    return null;
  }

  if (raw && typeof raw === 'object' && '__error' in raw) {
    log.warn('IndexedDB read error from renderer:', (raw as { __error: string }).__error);
    return null;
  }

  // The script answers with `{ messages, stats, categoryCounts, inboxUnreadTotal }`.
  const payload = raw as {
    messages?: unknown;
    stats?: {
      scanned?: number;
      inbox?: number;
      reason?: string;
      foundDbs?: string[];
      href?: string;
    };
    categoryCounts?: Record<string, number>;
    inboxUnreadTotal?: number;
  };
  if (!payload || !Array.isArray(payload.messages)) {
    log.warn('IndexedDB read returned an unexpected shape:', typeof raw);
    return null;
  }

  const stats = payload.stats ?? {};
  if (stats.reason === 'no-db') {
    const found =
      Array.isArray(stats.foundDbs) && stats.foundDbs.length > 0
        ? `found: [${stats.foundDbs.join(', ')}]`
        : 'no IndexedDB databases found';
    log.info(
      `No cached messages: Gmail has not created its cache database yet (${found}, frame: ${stats.href ?? 'unknown'})`,
    );
    return {
      messages: [],
      categoryCounts: new Map(),
      inboxUnreadTotal: 0,
      stats,
    };
  }

  log.info(
    `Gmail cache: kept ${payload.messages.length} of ${stats.scanned ?? 0} decoded records ` +
      `(${stats.inbox ?? 0} in Inbox, ${payload.inboxUnreadTotal ?? 0} unread)`,
  );

  const items: TrayMessageItem[] = [];
  for (const entry of payload.messages as RawCacheMessage[]) {
    if (typeof entry?.id !== 'string' || !entry.id) continue;
    items.push({
      id: entry.id,
      threadId: entry.threadId,
      from: entry.from ?? '',
      subject: entry.subject ?? '',
      snippet: entry.snippet ?? '',
      modified: entry.timestampMs ? new Date(entry.timestampMs) : undefined,
      category: entry.category ?? 'primary',
      unread: entry.unread,
    });
  }

  const categoryCounts = new Map<NotificationCategory, number>();
  if (payload.categoryCounts && typeof payload.categoryCounts === 'object') {
    for (const [cat, count] of Object.entries(payload.categoryCounts)) {
      if (typeof count === 'number') {
        categoryCounts.set(cat as NotificationCategory, count);
      }
    }
  }

  return {
    messages: items,
    categoryCounts,
    inboxUnreadTotal: payload.inboxUnreadTotal ?? 0,
    stats,
  };
}

/**
 * Backward-compatible helper reading only the recent tray messages.
 */
export async function readRecentCachedMessages(
  webContents: WebContents,
  maxResults = 20,
): Promise<TrayMessageItem[] | null> {
  const result = await readCachedInboxData(webContents, maxResults);
  if (!result || result.stats.reason === 'no-db') return null;
  return result.messages;
}
