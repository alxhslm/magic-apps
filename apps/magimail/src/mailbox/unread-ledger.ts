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

/** A row is kept this long after its last observation so the popover has history. */
const MAX_RECENT_ROWS = 200;

/**
 * Pure, deterministic state machine for unread email reconciliation.
 *
 * The ledger owns the recent rows as well as the count, so the popover, widgets and
 * badge all read one state. Atom and cache are evidence; local actions are records.
 *
 * Each source carries its own freshness:
 *
 * - Atom is trusted as of its response generation time minus the read-path grace.
 * - The cache's own last item-sync time is its boundary; a row's modified time is
 *   the fallback when the schema does not expose it.
 * - A row's `sourceAsOf` is the observation that last set its state, so an older
 *   source cannot overwrite a newer one.
 *
 * A local action is a record, never an edit to the Atom base. The base is replaced on
 * every poll; records adjust it until a source fresh enough to include the action
 * confirms or contradicts it.
 */

interface MarkedUnreadRecord {
  markedAt: number;
  acceptedAt?: number;
  category: NotificationCategory;
  previousUnread?: boolean;
  previousSourceAsOf?: number;
  addedKey?: string;
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
  private recent = new Map<string, UnreadLedgerItem>();
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
   *
   * The row's unread flag changes immediately. The record is in flight until the driver
   * confirms it, and sources cannot overwrite it during that window.
   */
  public recordLocalTriage(
    id: string,
    threadId: string,
    action: TriageAction,
    category: NotificationCategory = 'primary',
    now: number = Date.now(),
  ): void {
    this.pruneRecordsBefore(this.atomAsOf);

    const found = this.findRecent(id, threadId);
    const targetId = found?.key ?? id;
    const item = found?.item;
    const resolvedCategory = item?.category ?? category;

    if (action === 'markUnread') {
      // A mark-unread supersedes a reducing triage on the same thread, and vice versa.
      this.clearTriageFor(id, threadId, targetId);
      this.clearMarkedUnreadFor(id, threadId, targetId);

      if (item?.unread) return;

      const previousUnread = item?.unread;
      const previousSourceAsOf = item?.sourceAsOf;
      if (item) {
        item.unread = true;
        item.category = resolvedCategory;
      } else {
        this.recent.set(targetId, {
          id,
          threadId: threadId || id,
          category: resolvedCategory,
          unread: true,
          observedAt: now,
        });
      }

      const markRecord: MarkedUnreadRecord = {
        markedAt: now,
        acceptedAt: now,
        category: resolvedCategory,
        previousUnread,
        previousSourceAsOf,
        addedKey: item ? undefined : targetId,
      };
      this.recentlyMarkedUnread.set(id, markRecord);
      if (threadId && threadId !== id) this.recentlyMarkedUnread.set(threadId, markRecord);
      if (targetId && targetId !== id && targetId !== threadId) {
        this.recentlyMarkedUnread.set(targetId, markRecord);
      }
      return;
    }

    // A read row can be archived from the popover. It was never counted, so it must
    // not move the badge and must not leave a record that subtracts from the feed.
    if (!item || !item.unread) return;

    this.clearMarkedUnreadFor(id, threadId, targetId);

    const record: TriagedRecord = {
      triagedAt: now,
      acceptedAt: now,
      action,
      category: item.category,
      previousUnread: item.unread,
      previousSourceAsOf: item.sourceAsOf,
    };
    item.unread = false;

    this.recentlyTriaged.set(id, record);
    if (threadId && threadId !== id) this.recentlyTriaged.set(threadId, record);
    if (targetId && targetId !== id && targetId !== threadId) {
      this.recentlyTriaged.set(targetId, record);
    }
  }

  /**
   * Marks the action as confirmed by the driver. Sources newer than this time may
   * now win; sources older than it may not.
   */
  public acceptLocalTriage(id: string, threadId: string, acceptedAt: number = Date.now()): void {
    const triage = this.findTriageRecord(id, threadId);
    if (triage) triage.acceptedAt = acceptedAt;
    const mark = this.findMarkRecord(id, threadId);
    if (mark) mark.acceptedAt = acceptedAt;
  }

  /** Clears the confirmation time until the driver answers. */
  public markLocalTriageInFlight(id: string, threadId: string): void {
    const triage = this.findTriageRecord(id, threadId);
    if (triage) triage.acceptedAt = undefined;
    const mark = this.findMarkRecord(id, threadId);
    if (mark) mark.acceptedAt = undefined;
  }

  /**
   * Puts the optimistic change back when the driver could not land the action.
   * Returns whether anything changed.
   */
  public rollbackLocalTriage(id: string, threadId: string): boolean {
    let changed = false;

    const triage = this.findTriageRecord(id, threadId);
    if (triage) {
      const row = this.findRecent(id, threadId);
      if (row) {
        row.item.unread = triage.previousUnread ?? true;
        row.item.sourceAsOf = triage.previousSourceAsOf;
      }
      this.clearTriageRecord(triage);
      changed = true;
    }

    const mark = this.findMarkRecord(id, threadId);
    if (mark) {
      if (mark.addedKey) {
        const row = this.findRecent(id, threadId);
        if (row) this.recent.delete(row.key);
      } else {
        const row = this.findRecent(id, threadId);
        if (row) {
          row.item.unread = mark.previousUnread ?? false;
          row.item.sourceAsOf = mark.previousSourceAsOf;
        }
      }
      this.clearMarkedUnreadRecord(mark);
      changed = true;
    }

    return changed;
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
        if (
          triage.acceptedAt !== undefined &&
          changedAt !== undefined &&
          changedAt >= triage.acceptedAt
        ) {
          // The thread changed on the server after the action was confirmed, so this
          // entry is a later truth and wins immediately.
          this.clearTriageRecord(triage);
        } else {
          // In flight, or the feed predates the action. Suppress until a source is
          // fresh enough to include the action.
          continue;
        }
      }

      const found = this.findRecent(entry.id, entry.threadId);
      if (found) {
        if (found.key !== entry.id) {
          this.recent.delete(found.key);
          found.item.id = entry.id;
          this.recent.set(entry.id, found.item);
        }
        if (found.item.sourceAsOf !== undefined && atomAsOf < found.item.sourceAsOf) {
          // A newer cache row already set this row's state.
          continue;
        }
        if (!found.item.unread) added.push(entry.id);
        found.item.unread = true;
        found.item.sourceAsOf = atomAsOf;
        found.item.category = entry.category ?? found.item.category;
        found.item.subject = entry.subject || found.item.subject;
        found.item.from = entry.from || found.item.from;
        found.item.snippet = entry.snippet || found.item.snippet;
        const modifiedMs = parseModifiedMs(entry.modified);
        if (modifiedMs !== undefined) found.item.timestampMs = modifiedMs;
      } else {
        const item: UnreadLedgerItem = {
          id: entry.id,
          threadId: entry.threadId || entry.id,
          category: entry.category ?? 'primary',
          unread: true,
          observedAt: now,
          sourceAsOf: atomAsOf,
          timestampMs: parseModifiedMs(entry.modified),
          subject: entry.subject,
          from: entry.from,
          snippet: entry.snippet,
        };
        this.recent.set(entry.id, item);
        added.push(entry.id);
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

    // A complete feed also tells us which previously unread rows are now read.
    if (feedIsComplete) {
      for (const [key, item] of this.recent.entries()) {
        if (!item.unread) continue;
        if (this.markedUnreadFor(key, item.threadId)) continue;
        if (feedIds.has(key) || feedThreadIds.has(item.threadId)) continue;
        if (item.sourceAsOf !== undefined && atomAsOf < item.sourceAsOf) continue;
        item.unread = false;
        item.sourceAsOf = atomAsOf;
        removed.push(key);
      }
    }

    this.lastFullCount = fullCount;
    this.lastDisplayedUnread =
      displayedUnread !== undefined
        ? displayedUnread
        : this.deriveDisplayedUnread(fullCount, entries);
    this.pruneRecent();

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
   * A row is trusted for a thread only when the cache's update time is at or after
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
      const sourceAsOf = cacheAsOf !== undefined && cacheAsOf > 0 ? cacheAsOf : undefined;

      if (triage || markRecord) {
        const acceptedAt = triage?.acceptedAt ?? markRecord?.acceptedAt;
        if (acceptedAt !== undefined && sourceAsOf !== undefined && sourceAsOf >= acceptedAt) {
          // The cache is newer than the confirmed action, so it is a later truth.
          if (triage) this.clearTriageRecord(triage);
          if (markRecord) this.clearMarkedUnreadRecord(markRecord);
        } else {
          // In flight, or the row predates the action. Ignore its unread flag.
          continue;
        }
      }

      const found = this.findRecent(msg.id, msg.threadId);
      if (found) {
        if (
          sourceAsOf !== undefined &&
          found.item.sourceAsOf !== undefined &&
          sourceAsOf < found.item.sourceAsOf
        ) {
          // Atom already gave this row a newer state.
          continue;
        }
        found.item.category = parseCategory(msg.category) ?? found.item.category;
        found.item.subject = msg.subject || found.item.subject;
        found.item.from = msg.from || found.item.from;
        found.item.snippet = msg.snippet || found.item.snippet;
        const modifiedMs = parseModifiedMs(msg.modified);
        if (modifiedMs !== undefined) found.item.timestampMs = modifiedMs;
        if (sourceAsOf !== undefined) {
          found.item.unread = Boolean(msg.unread);
          found.item.sourceAsOf = sourceAsOf;
        }
        enriched.push(msg.id);
      } else {
        this.recent.set(msg.id, {
          id: msg.id,
          threadId: msg.threadId || msg.id,
          category: parseCategory(msg.category) ?? 'primary',
          unread: Boolean(msg.unread),
          observedAt: now,
          sourceAsOf,
          timestampMs: parseModifiedMs(msg.modified),
          subject: msg.subject,
          from: msg.from,
          snippet: msg.snippet,
        });
        enriched.push(msg.id);
      }
    }

    this.pruneRecent();
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

    let unreadCount = 0;
    for (const item of this.recent.values()) {
      if (!item.unread) continue;
      unreadCount += 1;
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
      this.lastFullCount !== null && (this.lastFullCount > 20 || this.lastFullCount > unreadCount);

    return {
      total: Math.max(0, total),
      byCategory,
      arrivalsIncomplete,
      rawFullCount: this.lastFullCount,
      activeCount: unreadCount,
      hasState:
        this.lastFullCount !== null ||
        this.recent.size > 0 ||
        this.recentlyTriaged.size > 0 ||
        this.recentlyMarkedUnread.size > 0,
    };
  }

  /** The recent rows, read and unread, newest first. */
  public getRecentMessages(limit = 20): TrayMessageItem[] {
    return [...this.recent.values()]
      .sort((a, b) => (b.timestampMs ?? b.observedAt) - (a.timestampMs ?? a.observedAt))
      .slice(0, limit)
      .map((item) => ({
        id: item.id,
        threadId: item.threadId,
        from: item.from ?? '',
        subject: item.subject ?? '',
        snippet: item.snippet ?? '',
        modified: item.timestampMs ? new Date(item.timestampMs) : undefined,
        category: item.category,
        unread: item.unread,
      }));
  }

  public updateNotificationSettings(settings: Record<string, string>): void {
    this.notificationSettings = { ...settings };
  }

  /** Unread rows only, for callers that track the unread set rather than the list. */
  public getTrackedItems(): UnreadLedgerItem[] {
    return [...this.recent.values()].filter((item) => item.unread);
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

  private findTriageRecord(id: string, threadId?: string): TriagedRecord | undefined {
    return (
      this.recentlyTriaged.get(id) ?? (threadId ? this.recentlyTriaged.get(threadId) : undefined)
    );
  }

  private findMarkRecord(id: string, threadId?: string): MarkedUnreadRecord | undefined {
    return this.markedUnreadFor(id, threadId);
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

  /** Finds a recent row by message id, then by thread id. */
  private findRecent(
    id: string,
    threadId?: string,
  ): { key: string; item: UnreadLedgerItem } | undefined {
    const direct = this.recent.get(id);
    if (direct) return { key: id, item: direct };
    if (!threadId) return undefined;
    for (const [key, item] of this.recent.entries()) {
      if (item.threadId === threadId || item.id === threadId) {
        return { key, item };
      }
    }
    return undefined;
  }

  /** Drops records the feed is now fresh enough to have represented. */
  private pruneRecordsBefore(asOf: number): void {
    for (const [id, record] of this.recentlyTriaged.entries()) {
      const acceptedAt = record.acceptedAt ?? Number.POSITIVE_INFINITY;
      if (acceptedAt <= asOf) this.recentlyTriaged.delete(id);
    }
    for (const [id, record] of this.recentlyMarkedUnread.entries()) {
      const acceptedAt = record.acceptedAt ?? Number.POSITIVE_INFINITY;
      if (acceptedAt <= asOf) this.recentlyMarkedUnread.delete(id);
    }
  }

  /** Keeps the recent list bounded, preferring to drop read rows first. */
  private pruneRecent(): void {
    if (this.recent.size <= MAX_RECENT_ROWS) return;
    const rows = [...this.recent.entries()].sort(
      (a, b) => (a[1].timestampMs ?? a[1].observedAt) - (b[1].timestampMs ?? b[1].observedAt),
    );
    for (const [key, item] of rows) {
      if (this.recent.size <= MAX_RECENT_ROWS) break;
      if (!item.unread) this.recent.delete(key);
    }
    for (const [key] of rows) {
      if (this.recent.size <= MAX_RECENT_ROWS) break;
      this.recent.delete(key);
    }
  }
}
