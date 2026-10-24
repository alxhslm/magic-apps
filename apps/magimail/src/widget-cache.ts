import type { AccountConfig } from '@magimail/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TrayMessageItem } from './menubar-manager.js';
import { createLogger, redactText } from '@magimail/core/logger';
import { uiString } from './strings.js';

const log = createLogger('WidgetCache');

/**
 * Snapshot the WidgetKit extension reads to render its timeline.
 *
 * Lives in the App Group container both sides are entitled for, so the
 * extension needs no access to Application Support — where the Gmail session
 * cookies also live. Resolving the path goes through the native addon because
 * only `containerURL(forSecurityApplicationGroupIdentifier:)` makes
 * `containermanagerd` create a directory the sandboxed extension can open.
 */
export interface WidgetCache {
  updatedAt: number;
  totalUnread: number;
  accounts: WidgetCacheAccount[];
  messages: WidgetCacheMessage[];
}

export interface WidgetCacheAccount {
  id: string;
  name: string;
  color: string;
  email: string;
  unreadCount: number;
}

export interface WidgetCacheMessage {
  id: string;
  threadId: string;
  accountId: string;
  sender: string;
  subject: string;
  snippet: string;
  /** Milliseconds since the epoch. 0 when the feed gave no usable date. */
  date: number;
  /** Gmail category tab, `primary` while a poll has yet to classify the thread. */
  category: string;
  /**
   * Whether the thread is still unread, so the widget can draw it the way the
   * popover does. An omitted value counts as unread, which is how the popover
   * reads it too — see `TrayMessageItem.unread`.
   */
  unread: boolean;
}

/** How many threads to keep. The large widget shows at most four. */
const MAX_MESSAGES = 8;

const CACHE_FILE = 'widget-cache.json';

/** Resolved once: the container is created on first call, not on every poll. */
let groupContainer: string | null | undefined;

/**
 * Where the extension reads the cache from, or null when this build cannot
 * claim the group. Warns once, on the call that resolves it.
 *
 * Injectable so the resolution rule can be tested without the native addon.
 */
export function widgetCachePath(resolveGroupContainer?: () => string | null): string | null {
  if (groupContainer === undefined) {
    try {
      groupContainer = resolveGroupContainer ? resolveGroupContainer() : null;
    } catch (error) {
      groupContainer = null;
      log.error('Resolving the App Group container failed', error);
    }
    if (groupContainer === null) {
      log.warn('No App Group container for this build; the widget renders its placeholder');
    }
  }
  return groupContainer ? path.join(groupContainer, CACHE_FILE) : null;
}

/** Forgets the resolved container. Tests only. */
export function resetWidgetCachePath(): void {
  groupContainer = undefined;
}

/** `Sender Name <a@b.com>` -> `Sender Name`, falling back to the raw value. */
function senderName(from: string): string {
  const match = from.match(/^"?([^"<]+)"?\s*</);
  return (match ? match[1] : from).trim();
}

export function buildWidgetCache(
  accounts: AccountConfig[],
  totalUnread: number,
  messagesByAccount: Map<string, TrayMessageItem[]>,
): WidgetCache {
  const messages: WidgetCacheMessage[] = [];

  for (const [accountId, accountMessages] of messagesByAccount) {
    for (const message of accountMessages) {
      const parsed = message.modified ? new Date(message.modified).getTime() : NaN;
      messages.push({
        id: message.id,
        threadId: message.threadId,
        accountId,
        sender: senderName(message.from),
        subject: message.subject || uiString('notification.noSubject'),
        snippet: message.snippet,
        date: Number.isNaN(parsed) ? 0 : parsed,
        category: message.category ?? 'primary',
        unread: message.unread !== false,
      });
    }
  }

  messages.sort((a, b) => b.date - a.date);

  return {
    updatedAt: Date.now(),
    totalUnread,
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      color: a.color,
      email: a.email || '',
      unreadCount: a.unreadCount,
    })),
    messages: messages.slice(0, MAX_MESSAGES),
  };
}

/** The part a widget draws. `updatedAt` moves every poll and changes nothing on screen. */
function contentKey(cache: WidgetCache): string {
  return JSON.stringify({
    totalUnread: cache.totalUnread,
    accounts: cache.accounts,
    messages: cache.messages,
  });
}

let lastWritten: string | undefined;

/** Forgets what was last written. Tests only. */
export function resetWidgetCacheContent(): void {
  lastWritten = undefined;
}

/**
 * Write the cache where the extension reads it, and say whether anything
 * changed. Does nothing when there is no container to write into.
 *
 * **Returns true only when the snapshot differs from the last one written**, so
 * the caller can reload the timelines on a changed mailbox rather than on every
 * poll. WidgetKit rations reloads per widget, and over-asking gets them merged
 * or ignored — which is what the Atom poller would do, running on every unread
 * change as well as its own schedule.
 *
 * Writes via a temporary file and renames, so the extension never observes a
 * half-written JSON document. Reloading the timelines is the caller's job —
 * see `reloadNativeWidgets`.
 */
export function writeWidgetCache(
  cache: WidgetCache,
  resolveGroupContainer?: () => string | null,
): boolean {
  const target = widgetCachePath(resolveGroupContainer);
  if (!target) return false;

  const key = contentKey(cache);
  if (key === lastWritten) return false;

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(cache), 'utf8');
    fs.renameSync(temp, target);
    lastWritten = key;
    return true;
  } catch (error) {
    log.error('Failed to write cache to', redactText(target), error);
    return false;
  }
}
