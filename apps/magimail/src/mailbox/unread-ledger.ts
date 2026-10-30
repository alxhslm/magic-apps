import type {
  AtomMessage,
  NotificationCategory,
  TrayMessageItem,
  TriageAction,
  TriagedRecord,
  UnreadBreakdown,
  UnreadLedgerItem,
} from './types.js';

export const CACHE_TRIAGE_GRACE_MS = 5000;

/**
 * Pure, deterministic state machine for unread email reconciliation.
 *
 * Reconciles Atom feed reports, local IndexedDB (_xdb) cache reads, and local triage
 * mutations without race conditions, state bounce, or email resurrection.
 */
function parseCategory(cat?: string): NotificationCategory | undefined {
  if (
    cat === 'primary' ||
    cat === 'updates' ||
    cat === 'promotions' ||
    cat === 'social' ||
    cat === 'forums'
  ) {
    return cat;
  }
  return undefined;
}

function parseModifiedMs(modified?: string | Date): number | undefined {
  if (!modified) return undefined;
  if (modified instanceof Date) return modified.getTime();
  const parsed = Date.parse(modified);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export class UnreadLedger {
  private activeUnread = new Map<string, UnreadLedgerItem>();
  private recentlyTriaged = new Map<string, TriagedRecord>();
  private recentlyMarkedUnread = new Map<string, { markedAt: number }>();
  private lastFullCount: number | null = null;
  private notificationSettings: Record<string, string> = {};
  private watermark = 0;

  constructor(initialSettings: Record<string, string> = {}) {
    this.notificationSettings = { ...initialSettings };
  }

  /**
   * 1. Local Triage Action
   * Invoked synchronously when user triggers triage from tray, notification, or shortcut.
   */
  public recordLocalTriage(
    id: string,
    threadId: string,
    action: TriageAction,
    category: NotificationCategory = 'primary',
    now: number = Date.now(),
  ): void {
    let targetId = id;
    let existing = this.activeUnread.get(id);
    if (!existing && threadId) {
      for (const [key, item] of this.activeUnread.entries()) {
        if (item.threadId === threadId || item.id === threadId) {
          existing = item;
          targetId = key;
          break;
        }
      }
    }

    const resolvedCategory = existing?.category ?? category;

    if (action === 'archive' || action === 'trash' || action === 'markRead') {
      this.activeUnread.delete(targetId);
      if (id !== targetId) {
        this.activeUnread.delete(id);
      }

      const record: TriagedRecord = {
        triagedAt: now,
        action,
        category: resolvedCategory,
      };

      this.recentlyTriaged.set(id, record);
      if (threadId && threadId !== id) {
        this.recentlyTriaged.set(threadId, record);
      }
      if (targetId && targetId !== id && targetId !== threadId) {
        this.recentlyTriaged.set(targetId, record);
      }

      if (this.lastFullCount !== null && this.lastFullCount > 0) {
        this.lastFullCount = Math.max(0, this.lastFullCount - 1);
      }
    } else if (action === 'markUnread') {
      this.recentlyTriaged.delete(id);
      if (threadId) this.recentlyTriaged.delete(threadId);
      if (targetId) this.recentlyTriaged.delete(targetId);

      // Keep an existing entry under the key it already has. Writing it under the
      // thread id as well would leave the old entry counted beside the new one.
      this.activeUnread.set(targetId, {
        id: existing?.id ?? id,
        threadId: threadId || existing?.threadId || id,
        category: resolvedCategory,
        unread: true,
        observedAt: existing?.observedAt ?? now,
        subject: existing?.subject,
        from: existing?.from,
        snippet: existing?.snippet,
        timestampMs: existing?.timestampMs,
      });

      // A stale cache read and a lagging feed both still say read. Hold the local
      // intent until the feed lists the thread or the grace window expires.
      const markRecord = { markedAt: now };
      this.recentlyMarkedUnread.set(id, markRecord);
      if (threadId && threadId !== id) this.recentlyMarkedUnread.set(threadId, markRecord);
      if (targetId && targetId !== id && targetId !== threadId) {
        this.recentlyMarkedUnread.set(targetId, markRecord);
      }

      if (!existing && this.lastFullCount !== null) {
        this.lastFullCount += 1;
      }
    }
  }

  /**
   * 2. Reconcile with Atom Feed
   * Invoked when AtomFeedPoller returns parsed XML (<fullcount> and <entry>[]).
   */
  public reconcileWithAtom(
    entries: AtomMessage[],
    fullCount: number | null,
    now: number = Date.now(),
  ): { added: string[]; removed: string[]; countChanged: boolean } {
    const added: string[] = [];
    const removed: string[] = [];
    const oldCount = this.getBreakdown().total;

    this.pruneExpiredTriage(now);

    const feedIds = new Set<string>();
    const feedThreadIds = new Set<string>();

    for (const entry of entries) {
      if (!entry.id) continue;
      feedIds.add(entry.id);
      if (entry.threadId) feedThreadIds.add(entry.threadId);

      // The feed listing a locally marked-unread thread is its confirmation.
      const markRecord = this.markedUnreadFor(entry.id, entry.threadId);
      if (markRecord) this.clearMarkedUnread(markRecord);

      // Check if message is currently suppressed by local triage grace window
      const triage =
        this.recentlyTriaged.get(entry.id) ??
        (entry.threadId ? this.recentlyTriaged.get(entry.threadId) : undefined);

      if (triage) {
        if (now - triage.triagedAt < CACHE_TRIAGE_GRACE_MS) {
          // Lagging edge-cache: suppress resurrection
          triage.seenInFeed = true;
          continue;
        } else {
          // Grace expired and message is still present: evict triage record
          this.recentlyTriaged.delete(entry.id);
          if (entry.threadId) this.recentlyTriaged.delete(entry.threadId);
        }
      }

      const found = this.findActive(entry.id, entry.threadId);
      if (!found) {
        const item: UnreadLedgerItem = {
          id: entry.id,
          threadId: entry.threadId || entry.id,
          category: entry.category ?? 'primary',
          unread: true,
          observedAt: now,
          subject: entry.subject,
          from: entry.from,
          snippet: entry.snippet,
        };
        this.activeUnread.set(entry.id, item);
        added.push(entry.id);
      } else {
        const { key, item } = found;
        // A preemptive markUnread is keyed by thread id. Adopt the feed's id now
        // that it knows one, so the same thread is not counted twice.
        if (key !== entry.id) {
          this.activeUnread.delete(key);
          item.id = entry.id;
          this.activeUnread.set(entry.id, item);
        }
        if (entry.category && item.category !== entry.category) {
          item.category = entry.category;
        }
        if (entry.subject) item.subject = entry.subject;
        if (entry.from) item.from = entry.from;
        if (entry.snippet) item.snippet = entry.snippet;
      }
    }

    // Server confirmation of local triage: a complete feed that no longer lists
    // the item proves the write landed, as does an item that was listed during
    // grace and has since gone. A truncated feed proves nothing on its own, so a
    // thread outside the 20-entry window stays pending until grace expires.
    const feedIsComplete = fullCount !== null && fullCount <= 20 && fullCount <= entries.length;
    for (const [triagedKey, record] of this.recentlyTriaged.entries()) {
      const absent = !feedIds.has(triagedKey) && !feedThreadIds.has(triagedKey);
      if (absent && (feedIsComplete || record.seenInFeed)) {
        this.recentlyTriaged.delete(triagedKey);
      }
    }

    // Atom's fullcount is authoritative, less the local triages the server has
    // not yet propagated. Counting unique triage records rather than feed entries
    // keeps a backlog decrement when the thread sits outside the 20-entry window.
    const pendingTriage = new Set<TriagedRecord>();
    for (const record of this.recentlyTriaged.values()) {
      if (now - record.triagedAt < CACHE_TRIAGE_GRACE_MS) pendingTriage.add(record);
    }
    const pendingMarkUnread = new Set<{ markedAt: number }>();
    for (const record of this.recentlyMarkedUnread.values()) {
      if (now - record.markedAt < CACHE_TRIAGE_GRACE_MS) pendingMarkUnread.add(record);
    }
    this.lastFullCount =
      fullCount === null
        ? null
        : Math.max(0, fullCount + pendingMarkUnread.size - pendingTriage.size);

    // Small inbox reconciliation: <= 20 unread (or fullCount <= entries.length)
    // The feed returned every unread item in existence. Any item in activeUnread
    // that is NOT in feedIds was triaged remotely (iPhone, Web, another client).
    const isSmallInbox = fullCount !== null && (fullCount <= entries.length || fullCount <= 20);
    if (isSmallInbox) {
      for (const [activeId, item] of this.activeUnread.entries()) {
        if (this.markedUnreadFor(activeId, item.threadId)) continue;
        if (!feedIds.has(activeId) && !feedThreadIds.has(item.threadId)) {
          this.activeUnread.delete(activeId);
          removed.push(activeId);
        }
      }
    }

    const newCount = this.getBreakdown().total;
    return {
      added,
      removed,
      countChanged: oldCount !== newCount,
    };
  }

  /**
   * 3. Reconcile with IndexedDB Cache Snapshot
   * Invoked after readCachedInboxData reads _xdb.
   */
  public reconcileWithCache(
    snapshotMessages: TrayMessageItem[],
    now: number = Date.now(),
  ): { enriched: string[] } {
    const enriched: string[] = [];
    this.pruneExpiredTriage(now);

    for (const msg of snapshotMessages) {
      if (!msg.id) continue;

      // Protection against stale cache resurrection:
      const triage =
        this.recentlyTriaged.get(msg.id) ??
        (msg.threadId ? this.recentlyTriaged.get(msg.threadId) : undefined);

      if (triage && now - triage.triagedAt < CACHE_TRIAGE_GRACE_MS) {
        continue;
      }

      const found = this.findActive(msg.id, msg.threadId);
      const markRecord = this.markedUnreadFor(msg.id, msg.threadId);

      if (!msg.unread) {
        // A cache that still says read has not seen a local mark-unread yet.
        if (markRecord) continue;
        // If cache explicitly says read and we have it as active unread,
        // remove it (unless it was just marked unread)
        if (found && triage?.action !== 'markUnread') {
          this.activeUnread.delete(found.key);
        }
        continue;
      }

      // If it's unread in cache:
      const existing = found?.item;
      const parsedCat = parseCategory(msg.category);
      const modifiedMs = parseModifiedMs(msg.modified);
      if (existing) {
        // Enrich metadata from _xdb protobuf
        existing.category = parsedCat ?? existing.category;
        existing.subject = msg.subject || existing.subject;
        existing.from = msg.from || existing.from;
        existing.snippet = msg.snippet || existing.snippet;
        if (modifiedMs !== undefined) existing.timestampMs = modifiedMs;
        enriched.push(msg.id);
      } else {
        // If we are in backlog mode (> 20) and Atom has not listed this item yet,
        // add it as tracked active unread
        if (this.lastFullCount === null || this.lastFullCount > 20) {
          this.activeUnread.set(msg.id, {
            id: msg.id,
            threadId: msg.threadId || msg.id,
            category: parsedCat ?? 'primary',
            unread: true,
            observedAt: now,
            subject: msg.subject,
            from: msg.from,
            snippet: msg.snippet,
            timestampMs: modifiedMs,
          });
          enriched.push(msg.id);
        }
      }
    }

    return { enriched };
  }

  /**
   * Calculates the current unread breakdown respecting user notification preferences.
   */
  public getBreakdown(): UnreadBreakdown {
    const byCategory = new Map<NotificationCategory, number>([
      ['primary', 0],
      ['updates', 0],
      ['promotions', 0],
      ['social', 0],
      ['forums', 0],
    ]);

    for (const item of this.activeUnread.values()) {
      if (!item.unread) continue;
      const cat = item.category || 'primary';
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
    }

    let activeDisplayed = 0;
    for (const [cat, count] of byCategory.entries()) {
      if (this.notificationSettings[cat] !== 'off') {
        activeDisplayed += count;
      }
    }

    let total = activeDisplayed;
    const arrivalsIncomplete =
      this.lastFullCount !== null &&
      (this.lastFullCount > 20 || this.lastFullCount > this.activeUnread.size);

    // Backlog mathematical ceiling:
    // If fullCount > 20, the server fullCount is the absolute ceiling.
    if (this.lastFullCount !== null) {
      if (this.lastFullCount <= 20) {
        total = activeDisplayed;
      } else {
        const totalActive = this.activeUnread.size;
        if (totalActive > 0) {
          const enabledRatio = activeDisplayed / totalActive;
          total = Math.round(this.lastFullCount * enabledRatio);
        } else {
          total = this.lastFullCount;
        }
      }
    }

    return {
      total: Math.max(0, total),
      byCategory,
      arrivalsIncomplete,
      rawFullCount: this.lastFullCount,
      activeCount: this.activeUnread.size,
    };
  }

  public updateNotificationSettings(settings: Record<string, string>): void {
    this.notificationSettings = { ...settings };
  }

  public getTrackedItems(): UnreadLedgerItem[] {
    return Array.from(this.activeUnread.values());
  }

  public clearRecentlyTriaged(): void {
    this.recentlyTriaged.clear();
    this.recentlyMarkedUnread.clear();
  }

  private markedUnreadFor(id: string, threadId?: string): { markedAt: number } | undefined {
    return (
      this.recentlyMarkedUnread.get(id) ??
      (threadId ? this.recentlyMarkedUnread.get(threadId) : undefined)
    );
  }

  private clearMarkedUnread(record: { markedAt: number }): void {
    for (const [key, candidate] of this.recentlyMarkedUnread.entries()) {
      if (candidate === record) this.recentlyMarkedUnread.delete(key);
    }
  }

  /** Finds a tracked item by message id, then by thread id. */
  private findActive(
    id: string,
    threadId?: string,
  ): { key: string; item: UnreadLedgerItem } | undefined {
    const direct = this.activeUnread.get(id);
    if (direct) return { key: id, item: direct };
    if (!threadId) return undefined;
    for (const [key, item] of this.activeUnread.entries()) {
      if (item.threadId === threadId || item.id === threadId) {
        return { key, item };
      }
    }
    return undefined;
  }

  private pruneExpiredTriage(now: number): void {
    for (const [id, record] of this.recentlyTriaged.entries()) {
      if (now - record.triagedAt >= CACHE_TRIAGE_GRACE_MS) {
        this.recentlyTriaged.delete(id);
      }
    }
    for (const [id, record] of this.recentlyMarkedUnread.entries()) {
      if (now - record.markedAt >= CACHE_TRIAGE_GRACE_MS) {
        this.recentlyMarkedUnread.delete(id);
      }
    }
  }
}
