import type {
  AtomMessage,
  NotificationCategory,
  TrayMessageItem,
  TriageAction,
  TriagedRecord,
  UnreadBreakdown,
  UnreadLedgerItem,
} from './types.js';

/**
 * How long Gmail's read path may lag behind a mutation the app has dispatched.
 * The feed is served no-store with no Age, so this is not an HTTP cache age: it is
 * the bound on how long a generated feed may still show the pre-mutation state.
 */
export const ATOM_READ_PATH_GRACE_MS = 5000;

/**
 * Pure, deterministic state machine for unread email reconciliation.
 *
 * Each source carries its own freshness:
 *
 * - Atom is trusted as of its response generation time minus the read-path grace.
 *   The grace is a bound on backend propagation, not an HTTP cache age.
 * - The cache's own last item-sync time is its boundary; a row's modified time is
 *   the fallback when the schema does not expose it.
 *
 * A local action is a record, never an edit to the Atom base. The base is replaced on
 * every poll; records adjust it until a source fresh enough to include the action
 * confirms or contradicts it.
 */

interface MarkedUnreadRecord {
  markedAt: number;
  category: NotificationCategory;
}

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
  private recentlyMarkedUnread = new Map<string, MarkedUnreadRecord>();
  /** Raw <fullcount> from the last feed. */
  private lastFullCount: number | null = null;
  /** Feed count after disabled categories were removed. */
  private lastDisplayedUnread: number | null = null;
  /** The mailbox time the last Atom response is trusted as of. */
  private atomAsOf = 0;
  private notificationSettings: Record<string, string> = {};

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
    this.pruneRecordsBefore(this.atomAsOf);

    const found = this.findActive(id, threadId);
    const targetId = found?.key ?? id;
    const existing = found?.item;
    const resolvedCategory = existing?.category ?? category;

    if (action === 'markUnread') {
      // A mark-unread supersedes a reducing triage on the same thread, and vice versa.
      this.clearTriageFor(id, threadId, targetId);
      this.clearMarkedUnreadFor(id, threadId, targetId);

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

      // An already-unread thread is already counted. Only a thread that was not
      // counted needs a pending addition against the feed.
      if (!existing) {
        const markRecord: MarkedUnreadRecord = { markedAt: now, category: resolvedCategory };
        this.recentlyMarkedUnread.set(id, markRecord);
        if (threadId && threadId !== id) this.recentlyMarkedUnread.set(threadId, markRecord);
        if (targetId && targetId !== id && targetId !== threadId) {
          this.recentlyMarkedUnread.set(targetId, markRecord);
        }
      }
      return;
    }

    // A read row can be archived from the popover. It was never counted, so it must
    // not move the badge and must not leave a record that subtracts from the feed.
    if (!existing) return;

    this.activeUnread.delete(targetId);
    if (id !== targetId) this.activeUnread.delete(id);
    this.clearMarkedUnreadFor(id, threadId, targetId);

    const record: TriagedRecord = {
      triagedAt: now,
      action,
      category: resolvedCategory,
    };
    this.recentlyTriaged.set(id, record);
    if (threadId && threadId !== id) this.recentlyTriaged.set(threadId, record);
    if (targetId && targetId !== id && targetId !== threadId) {
      this.recentlyTriaged.set(targetId, record);
    }
  }

  /**
   * 2. Reconcile with Atom Feed
   * Invoked when AtomFeedPoller returns parsed XML (<fullcount> and <entry>[]).
   *
   * `displayedUnread` is the feed's count after disabled categories were removed.
   * When omitted, it is derived from the entries for a complete feed and from the
   * raw fullcount for a backlog.
   */
  public reconcileWithAtom(
    entries: AtomMessage[],
    fullCount: number | null,
    now: number = Date.now(),
    displayedUnread?: number | null,
    sourceAsOf?: number,
  ): { added: string[]; removed: string[]; countChanged: boolean } {
    const added: string[] = [];
    const removed: string[] = [];
    const oldCount = this.getBreakdown().total;

    // A response generated at G may still be showing the mailbox from G - grace.
    const atomAsOf = (sourceAsOf ?? now) - ATOM_READ_PATH_GRACE_MS;
    this.atomAsOf = atomAsOf;
    this.pruneRecordsBefore(atomAsOf);

    const feedIds = new Set<string>();
    const feedThreadIds = new Set<string>();

    for (const entry of entries) {
      if (!entry.id) continue;
      feedIds.add(entry.id);
      if (entry.threadId) feedThreadIds.add(entry.threadId);

      // The feed listing a locally marked-unread thread is its confirmation.
      const markRecord = this.markedUnreadFor(entry.id, entry.threadId);
      if (markRecord) this.clearMarkedUnreadRecord(markRecord);

      const triage =
        this.recentlyTriaged.get(entry.id) ??
        (entry.threadId ? this.recentlyTriaged.get(entry.threadId) : undefined);

      if (triage) {
        const changedAt = parseModifiedMs(entry.modified);
        if (changedAt !== undefined && changedAt >= triage.triagedAt) {
          // The thread changed on the server after the local action, so this entry
          // is a later truth and wins immediately.
          this.clearTriageRecord(triage);
        } else {
          // The feed predates the action, or carries no timestamp to prove otherwise.
          // Suppress it until the source is fresh enough to include the action.
          continue;
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

    // Server confirmation of local triage: only a complete feed can confirm a
    // reduction by omission. A truncated feed may simply have pushed the thread
    // out of its twenty-entry window, so absence there proves nothing.
    const feedIsComplete = fullCount !== null && fullCount <= 20 && fullCount <= entries.length;
    if (feedIsComplete) {
      for (const record of new Set(this.recentlyTriaged.values())) {
        if (!this.triageRecordInFeed(record, feedIds, feedThreadIds)) {
          this.clearTriageRecord(record);
        }
      }
    }

    this.lastFullCount = fullCount;
    this.lastDisplayedUnread =
      displayedUnread !== undefined
        ? displayedUnread
        : this.deriveDisplayedUnread(fullCount, entries);

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
   *
   * A row is trusted for a thread only when the row's modified time is at or after
   * the local action. Otherwise the row predates the action and is ignored for that
   * thread; Atom's freshness cutoff eventually releases the action.
   */
  public reconcileWithCache(
    snapshotMessages: TrayMessageItem[],
    now: number = Date.now(),
    cacheAsOf?: number,
  ): { enriched: string[] } {
    const enriched: string[] = [];
    this.pruneRecordsBefore(this.atomAsOf);

    for (const msg of snapshotMessages) {
      if (!msg.id) continue;

      const triage =
        this.recentlyTriaged.get(msg.id) ??
        (msg.threadId ? this.recentlyTriaged.get(msg.threadId) : undefined);
      const markRecord = this.markedUnreadFor(msg.id, msg.threadId);
      // The cache's own last-sync time is the boundary. A per-row timestamp is a
      // fallback for schemas that do not expose it.
      const rowAsOf =
        cacheAsOf !== undefined && cacheAsOf > 0 ? cacheAsOf : parseModifiedMs(msg.modified);

      if (triage || markRecord) {
        const actionAt = triage?.triagedAt ?? markRecord!.markedAt;
        if (rowAsOf !== undefined && rowAsOf >= actionAt) {
          // The row changed after the action, so it is a later truth.
          if (triage) this.clearTriageRecord(triage);
          if (markRecord) this.clearMarkedUnreadRecord(markRecord);
        } else {
          // The row predates the action (or cannot prove otherwise). Ignore its
          // read/unread assertion for this thread.
          continue;
        }
      }

      const found = this.findActive(msg.id, msg.threadId);

      if (!msg.unread) {
        // If cache explicitly says read and we have it as active unread, remove it.
        if (found) {
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
      if (this.isCategoryEnabled(cat)) activeDisplayed += count;
    }

    let total = activeDisplayed;
    if (this.lastDisplayedUnread !== null) {
      total =
        this.lastDisplayedUnread - this.countPendingTriaged() + this.countPendingMarkedUnread();
    }

    const arrivalsIncomplete =
      this.lastFullCount !== null &&
      (this.lastFullCount > 20 || this.lastFullCount > this.activeUnread.size);

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

  private isCategoryEnabled(category: NotificationCategory): boolean {
    return this.notificationSettings[category] !== 'off';
  }

  /** Unique reducing triages that still apply to a counted category. */
  private countPendingTriaged(): number {
    const records = new Set<TriagedRecord>();
    for (const record of this.recentlyTriaged.values()) {
      if (this.isCategoryEnabled(record.category)) records.add(record);
    }
    return records.size;
  }

  /** Unique mark-unread records that still apply to a counted category. */
  private countPendingMarkedUnread(): number {
    const records = new Set<MarkedUnreadRecord>();
    for (const record of this.recentlyMarkedUnread.values()) {
      if (this.isCategoryEnabled(record.category)) records.add(record);
    }
    return records.size;
  }

  private deriveDisplayedUnread(fullCount: number | null, entries: AtomMessage[]): number | null {
    if (fullCount === null) return null;
    // The feed is complete, so its entries are the exact counted set.
    if (fullCount <= entries.length) {
      let displayed = 0;
      for (const entry of entries) {
        if (this.isCategoryEnabled(entry.category ?? 'primary')) displayed += 1;
      }
      return displayed;
    }
    // A backlog only exposes its first twenty entries, so the raw ceiling is the
    // best available base. Production passes Atom's own filtered count instead.
    return fullCount;
  }

  private markedUnreadFor(id: string, threadId?: string): MarkedUnreadRecord | undefined {
    return (
      this.recentlyMarkedUnread.get(id) ??
      (threadId ? this.recentlyMarkedUnread.get(threadId) : undefined)
    );
  }

  private clearMarkedUnreadRecord(record: MarkedUnreadRecord): void {
    for (const [key, candidate] of this.recentlyMarkedUnread.entries()) {
      if (candidate === record) this.recentlyMarkedUnread.delete(key);
    }
  }

  private clearMarkedUnreadFor(id: string, threadId?: string, targetId?: string): void {
    const record =
      this.recentlyMarkedUnread.get(id) ??
      (threadId ? this.recentlyMarkedUnread.get(threadId) : undefined) ??
      (targetId ? this.recentlyMarkedUnread.get(targetId) : undefined);
    if (record) this.clearMarkedUnreadRecord(record);
  }

  private clearTriageRecord(record: TriagedRecord): void {
    for (const [key, candidate] of this.recentlyTriaged.entries()) {
      if (candidate === record) this.recentlyTriaged.delete(key);
    }
  }

  private clearTriageFor(id: string, threadId?: string, targetId?: string): void {
    const record =
      this.recentlyTriaged.get(id) ??
      (threadId ? this.recentlyTriaged.get(threadId) : undefined) ??
      (targetId ? this.recentlyTriaged.get(targetId) : undefined);
    if (record) this.clearTriageRecord(record);
  }

  private triageRecordInFeed(
    record: TriagedRecord,
    feedIds: Set<string>,
    feedThreadIds: Set<string>,
  ): boolean {
    for (const [key, candidate] of this.recentlyTriaged.entries()) {
      if (candidate !== record) continue;
      if (feedIds.has(key) || feedThreadIds.has(key)) return true;
    }
    return false;
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

  /** Drops records the feed is now fresh enough to have represented. */
  private pruneRecordsBefore(asOf: number): void {
    for (const [id, record] of this.recentlyTriaged.entries()) {
      if (record.triagedAt <= asOf) this.recentlyTriaged.delete(id);
    }
    for (const [id, record] of this.recentlyMarkedUnread.entries()) {
      if (record.markedAt <= asOf) this.recentlyMarkedUnread.delete(id);
    }
  }
}
