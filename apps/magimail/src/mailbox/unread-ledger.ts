import { createLogger } from '@magimail/core/logger';
import type {
  AtomMessage,
  NotificationCategory,
  TrayMessageItem,
  TriageAction,
  TriagedRecord,
  UnreadBreakdown,
  UnreadLedgerItem,
} from './types.js';

const log = createLogger('UnreadLedger');

/**
 * How long Gmail's read path may lag behind a mutation the app has dispatched.
 * The feed is served no-store with no Age, so this is not an HTTP cache age: it is
 * the bound on how long a generated feed may still show the pre-mutation state.
 */
export const ATOM_READ_PATH_GRACE_MS = 5000;

/** A row is kept this long after its last observation so the popover has history. */
/**
 * How many rows the ledger keeps.
 *
 * It has to hold the whole inbox the cache reader hands over, or the oldest rows
 * are pruned between reads and re-added as new, which loses the "did this row
 * move" comparison for exactly the threads that sit furthest from the top of the
 * list. The inbox here runs to about 310 threads, so this is a ceiling rather than
 * a working size.
 */
const MAX_RECENT_ROWS = 500;

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

  /**
   * The unread flag each row carried in the previous cache snapshot.
   *
   * A row that changed between two reads is evidence the cache moved, which the
   * store's own watermark cannot give: `items_sync_state.c` is the last item
   * sync and lands seconds after the row it describes. Gating on that watermark
   * alone discarded readings that were already right.
   */
  private lastSnapshotUnread = new Map<string, boolean>();
  /** Whether the last feed listed every unread thread. */
  private lastFeedComplete = false;
  /** Every id and thread id the last feed listed. */
  private lastFeedIds = new Set<string>();
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
    log.info(
      `Local ${action} id=${id} thread=${threadId} found=${Boolean(item)} unread=${item?.unread ?? 'none'}`,
    );

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
        item.localIntent = 'unread';
        item.localIntentAt = now;
      } else {
        this.recent.set(targetId, {
          id,
          threadId: threadId || id,
          category: resolvedCategory,
          unread: true,
          observedAt: now,
          localIntent: 'unread',
          localIntentAt: now,
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

    // A read row can be deleted from the popover. It was never counted, so it must
    // not move the badge, but it must leave the list immediately.
    if (!item) return;

    this.clearMarkedUnreadFor(id, threadId, targetId);

    const wasUnread = item.unread;
    if (!wasUnread && action === 'markRead') return;
    const record: TriagedRecord = {
      triagedAt: now,
      acceptedAt: now,
      action,
      category: item.category,
      previousUnread: wasUnread,
      previousSourceAsOf: item.sourceAsOf,
      countsInTotal: wasUnread,
    };
    item.unread = false;
    item.localIntent = action === 'trash' || !wasUnread ? 'removed' : 'read';
    item.localIntentAt = now;
    if (item.localIntent === 'removed') log.info(`Local ${action} hid row id=${id}`);

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
    const row = this.findRecent(id, threadId);
    if (row?.item.localIntent) row.item.localIntentAt = acceptedAt;
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
        row.item.localIntent = undefined;
        row.item.localIntentAt = undefined;
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
          row.item.localIntent = undefined;
          row.item.localIntentAt = undefined;
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
    categoryCounts?: Map<NotificationCategory, number>,
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
        // A listed entry cannot confirm a reduction. It may predate the action,
        // or its modified time may be our own label change before the read path
        // catches up. Absence from a complete feed, a cache that says read, or
        // the freshness boundary are the only confirmations.
        continue;
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
        if (!found.item.unread) {
          added.push(entry.id);
          log.info(`Feed set unread id=${entry.id}`);
        }
        found.item.unread = true;
        found.item.sourceAsOf = atomAsOf;
        found.item.localIntent = undefined;
        found.item.localIntentAt = undefined;
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
    this.lastFeedComplete = feedIsComplete;
    this.lastFeedIds = new Set([...feedIds, ...feedThreadIds]);
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
        item.localIntent = undefined;
        item.localIntentAt = undefined;
        removed.push(key);
      }
    }

    this.lastFullCount = fullCount;
    this.lastDisplayedUnread = this.deriveDisplayedUnread(fullCount, entries, categoryCounts);
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
   * Invoked after readCachedInboxData reads the local cache.
   *
   * A row is trusted for a thread only when the cache's update time is at or after
   * the local action. Otherwise the row predates the action and is ignored for that
   * thread; Atom's freshness cutoff eventually releases the action.
   */
  public reconcileWithCache(
    snapshotMessages: TrayMessageItem[],
    now: number = Date.now(),
    cacheAsOf?: number,
  ): { enriched: string[]; moved: number } {
    const enriched: string[] = [];
    const snapshotKeys = new Set<string>();
    let oldestSnapshotTs: number | undefined;
    // A read that moved a row and did not move the badge is the shape of every
    // regression this ledger has had, and it used to leave no trace at all: the
    // report that started the last investigation produced zero log lines.
    const totalBefore = this.getBreakdown().total;
    let rowsMoved = 0;
    let countedRowsMoved = 0;
    const movedDetail: string[] = [];
    this.pruneRecordsBefore(this.atomAsOf);

    for (const msg of snapshotMessages) {
      if (!msg.id) continue;
      snapshotKeys.add(msg.id);
      if (msg.threadId) snapshotKeys.add(msg.threadId);
      const snapshotTs = parseModifiedMs(msg.modified);
      if (snapshotTs !== undefined) {
        oldestSnapshotTs =
          oldestSnapshotTs === undefined ? snapshotTs : Math.min(oldestSnapshotTs, snapshotTs);
      }

      const triage =
        this.recentlyTriaged.get(msg.id) ??
        (msg.threadId ? this.recentlyTriaged.get(msg.threadId) : undefined);
      const markRecord = this.markedUnreadFor(msg.id, msg.threadId);
      const sourceAsOf = cacheAsOf !== undefined && cacheAsOf > 0 ? cacheAsOf : undefined;

      if (triage || markRecord) {
        // The pending record exists because the Atom base may still count this
        // thread. A cache read, however fresh, cannot remove that adjustment; it
        // can only update the row's category and metadata. The record clears
        // when the feed boundary passes, or when the feed proves the state.
        const found = this.findRecent(msg.id, msg.threadId);
        if (found) this.enrichFromCache(found.item, msg);
        continue;
      }

      // Whether this row moved since the previous snapshot, which is the only
      // evidence the cache itself carries. `items_sync_state` is the last item
      // sync and lands seconds after the row it describes, so it cannot speak for
      // a row that has just been rewritten.
      const snapshotChanged = this.lastSnapshotUnread.has(msg.id)
        ? this.lastSnapshotUnread.get(msg.id) !== Boolean(msg.unread)
        : false;

      // A complete feed that omits the message is proof it is read, but only as
      // of the feed's view. A row that has moved since the last snapshot was
      // written later than that, so its verdict is the newer one. Without this,
      // marking a message unread in Gmail was reverted to read by a feed that had
      // not caught up, and the badge waited 1-3s for the feed to agree.
      //
      // The watermark settles the remaining case, and it is the same comparison
      // the rest of this method uses: when the cache was written at or after the
      // feed's view, a row saying unread is newer than an omission, and forcing
      // it read makes the count oscillate until the feed catches up.
      const cacheIsNewerThanFeed = sourceAsOf !== undefined && sourceAsOf >= this.atomAsOf;
      const feedSaysNotUnread =
        !snapshotChanged &&
        !cacheIsNewerThanFeed &&
        this.lastFeedComplete &&
        msg.unread &&
        !this.lastFeedIds.has(msg.id) &&
        !(msg.threadId && this.lastFeedIds.has(msg.threadId));

      const found = this.findRecent(msg.id, msg.threadId);
      if (found?.item.localIntent === 'removed') {
        this.enrichFromCache(found.item, msg);
        continue;
      }
      if (feedSaysNotUnread) {
        if (found) {
          if (found.item.unread) log.info(`Complete feed marked read id=${found.item.id}`);
          this.enrichFromCache(found.item, msg);
          found.item.unread = false;
          found.item.sourceAsOf = this.atomAsOf;
          found.item.localIntent = undefined;
          found.item.localIntentAt = undefined;
        }
        continue;
      }
      if (found) {
        if (found.item.localIntent) {
          const confirmed =
            (found.item.localIntent === 'read' && !msg.unread) ||
            (found.item.localIntent === 'unread' && msg.unread);
          if (!confirmed) {
            this.enrichFromCache(found.item, msg);
            continue;
          }
          found.item.localIntent = undefined;
          found.item.localIntentAt = undefined;
        }
        // Measured on a live account: a Gmail-UI triage appeared in the rows at
        // 53.6s, the watermark advanced at 55.1s, and the badge did not move until
        // the feed answered at 55.0s. The row was right for 1.37s and this gate
        // threw it away. A row that changed since the last snapshot is that row.
        if (
          !snapshotChanged &&
          sourceAsOf !== undefined &&
          found.item.sourceAsOf !== undefined &&
          sourceAsOf < found.item.sourceAsOf
        ) {
          // Atom already gave this row a newer state, and nothing says the cache
          // has moved since, so the older row is skipped rather than allowed to
          // win. The watermark is trustworthy in this direction only.
          continue;
        }
        found.item.category = parseCategory(msg.category) ?? found.item.category;
        found.item.subject = msg.subject || found.item.subject;
        found.item.from = msg.from || found.item.from;
        found.item.snippet = msg.snippet || found.item.snippet;
        const modifiedMs = parseModifiedMs(msg.modified);
        if (modifiedMs !== undefined) found.item.timestampMs = modifiedMs;
        // Applied even without a watermark. A schema that does not expose
        // `items_sync_state` left `sourceAsOf` undefined, and the flag was then
        // never written, so the cache could not move the count at all.
        const wasUnread = found.item.unread;
        const nowUnread = Boolean(msg.unread);
        if (!wasUnread && nowUnread) {
          log.info(`Cache set unread id=${msg.id} asOf=${sourceAsOf ?? 'none'}`);
        }
        found.item.unread = nowUnread;
        if (sourceAsOf !== undefined) found.item.sourceAsOf = sourceAsOf;

        // The count is anchored to the feed's fullcount and adjusted only by
        // locally recorded intents, so a triage made in the Gmail UI left it
        // pinned until the next poll however fresh the rows were. This row
        // disagreeing with what is held is the evidence, so the anchor follows
        // it. Measured: the row was right at 53.6s, the badge moved at 55.0s.
        if (wasUnread !== nowUnread) {
          rowsMoved += 1;
          if (this.isCategoryEnabled(found.item.category)) countedRowsMoved += 1;
          movedDetail.push(
            `${msg.id.slice(0, 8)}:${nowUnread ? 'unread' : 'read'}:` +
              `${this.isCategoryEnabled(found.item.category) ? 'counted' : 'excluded'}` +
              `:${found.item.category}`,
          );
          if (this.lastDisplayedUnread !== null) {
            this.lastDisplayedUnread = Math.max(0, this.lastDisplayedUnread + (nowUnread ? 1 : -1));
          }
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

    // Recorded after the loop so the `continue`s above cannot skip a row, and
    // bounded so a long session cannot accumulate one entry per message ever seen.
    if (this.lastSnapshotUnread.size > 2000) this.lastSnapshotUnread.clear();
    for (const msg of snapshotMessages) {
      if (msg.id) this.lastSnapshotUnread.set(msg.id, Boolean(msg.unread));
    }

    if (rowsMoved > 0) {
      const totalAfter = this.getBreakdown().total;
      const detail =
        `Cache read: ${rowsMoved} of ${snapshotMessages.length} row(s) moved, ` +
        `total ${totalBefore} -> ${totalAfter}, asOf=${cacheAsOf ?? 'none'}, ` +
        `moved=[${movedDetail.join(' ')}], ` +
        `enabled=[${(['primary', 'updates', 'promotions', 'social', 'forums'] as const).filter((c) => this.isCategoryEnabled(c)).join(',')}]`;
      if (totalAfter === totalBefore && countedRowsMoved > 0) {
        // Only a counted row is expected to move the total. A silenced category
        // moving and the total holding still is the filter working, not a fault,
        // and warning about it buries the case that matters.
        log.warn(`${detail}. The badge did not follow, so something outvoted the row.`);
      } else {
        log.info(detail);
      }
    }

    this.pruneAbsentFromCache(snapshotKeys, oldestSnapshotTs);
    this.pruneRecent();
    return { enriched, moved: rowsMoved };
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

    // When the feed listed everything it counted, the rows are the whole picture
    // and the stored number is a second copy of the same fact. Two copies drift:
    // `feedSaysNotUnread` moves a row, a poll rewrites the number, and the next
    // cache read adds that row's change to a number that already carried it. That
    // is how a read-then-unread cycle ratcheted the badge upward, and it cleared
    // only when the feed next listed the message.
    //
    // So the rows decide whenever they can. The number stays for a backlog, where
    // `<fullcount>` exceeds the twenty entries the feed exposes and no list can
    // account for the rest. Pending local actions are already carried by the rows
    // in the first case, which is why they are only applied in the second.
    let total = activeDisplayed;
    if (!this.lastFeedComplete && this.lastDisplayedUnread !== null) {
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
      .filter((item) => item.localIntent !== 'removed')
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
      if (record.countsInTotal === false) continue;
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

  private deriveDisplayedUnread(
    fullCount: number | null,
    entries: AtomMessage[],
    categoryCounts?: Map<NotificationCategory, number>,
  ): number | null {
    if (fullCount === null) return null;

    // The feed is complete, so its entries are the exact counted set.
    if (fullCount <= entries.length) {
      let displayed = 0;
      for (const entry of entries) {
        if (this.isCategoryEnabled(entry.category ?? 'primary')) displayed += 1;
      }
      return displayed;
    }

    // A backlog only exposes its first twenty entries. Subtract the sub-feed
    // counts for disabled categories, capped at the total, as Atom reports them.
    let offCategoryCount = 0;
    for (const [category, count] of categoryCounts ?? []) {
      if (this.isCategoryEnabled(category)) continue;
      offCategoryCount += Math.min(count, fullCount);
    }
    return Math.max(0, fullCount - offCategoryCount);
  }

  /**
   * Drops read rows the cache no longer lists. The cache returns the newest
   * Inbox rows, so absence above the oldest returned row means the thread was
   * read, archived or deleted. Unread and pending rows are kept.
   */
  private pruneAbsentFromCache(keys: Set<string>, oldestTs?: number): void {
    if (keys.size === 0) return;
    for (const [key, item] of this.recent) {
      if (keys.has(key) || keys.has(item.id) || keys.has(item.threadId)) continue;
      if (item.unread) continue;
      if (this.recentlyTriaged.get(key) || this.recentlyTriaged.get(item.id)) continue;
      if (this.recentlyMarkedUnread.get(key) || this.recentlyMarkedUnread.get(item.id)) continue;
      const timestamp = item.timestampMs ?? item.observedAt;
      if (oldestTs !== undefined && timestamp < oldestTs) continue;
      log.info(`Cache dropped absent row id=${item.id}`);
      this.recent.delete(key);
    }
  }

  private enrichFromCache(item: UnreadLedgerItem, msg: TrayMessageItem): void {
    item.category = parseCategory(msg.category) ?? item.category;
    item.subject = msg.subject || item.subject;
    item.from = msg.from || item.from;
    item.snippet = msg.snippet || item.snippet;
    const modifiedMs = parseModifiedMs(msg.modified);
    if (modifiedMs !== undefined) item.timestampMs = modifiedMs;
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
