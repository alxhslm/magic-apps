import type { WebContentsView } from 'electron';
import { createLogger } from '@magimail/core/logger';
import {
  AtomFeedPoller,
  atomMessageToTrayMessageItem,
  clearPollerState,
  type AtomMessage,
  type AtomPollCallback,
  type AtomPollResult,
  type NotificationCategory,
} from '../atom-poller.js';
import { readCachedInboxData, type CachedInboxSnapshot } from '../gmail-cache-reader.js';
import { DomThreadActionDriver } from '../thread-actions/dom-driver.js';
import { FallbackThreadActionDriver } from '../thread-actions/fallback-driver.js';
import { pressRefreshControl, SyncThreadActionDriver } from '../thread-actions/sync-driver.js';
import type { ThreadActionDriver } from '../thread-actions/types.js';
import type {
  MailboxChangeEvent,
  MailboxPollEvent,
  MailboxSource,
  TrayMessageItem,
  TriageAction,
  UnreadBreakdown,
} from './types.js';
import { UnreadLedger } from './unread-ledger.js';

/** How many times a hint re-reads the cache, and how far apart. */
const CACHE_REREAD_ATTEMPTS = 3;
const CACHE_REREAD_INTERVAL_MS = 100;

/**
 * How many inbox threads a hint read asks for.
 *
 * The reader decodes every row in `_xdb` regardless, and only the slice limits
 * what comes back, so this costs serialisation and not decoding. It has to cover
 * the whole inbox: at twenty, a triage on any thread older than the newest twenty
 * was invisible to the read, and the count waited for the feed instead. Promotions
 * and Forums are older by nature, which is why they were the categories that
 * showed it.
 */
const CACHE_HINT_MAX_ROWS = 400;

const log = createLogger('HybridFeedSource');

export interface HybridFeedSourceOptions {
  getView?: (accountId: string) => WebContentsView | undefined;
  getAccountContext?: (accountId: string) => { partition: string } | undefined;
  partition?: string;
  notificationSettings?: Record<string, string>;
  /** Configured mains-power poll interval, in seconds. */
  pollIntervalSeconds?: number;
  /** Configured battery poll interval, in seconds. */
  pollIntervalBatterySeconds?: number;
  /** Overrides the direct-then-DOM driver, used by tests. */
  threadActionDriver?: ThreadActionDriver;
  /** Wakes the account's view for the DOM fallback. */
  wake?: (accountId: string) => Promise<{ view: WebContentsView; release: () => void } | undefined>;
  /** A press the view refused, to retry once the editor is free. */
  onActionHeld?: (accountId: string, threadId: string, action: TriageAction) => void;
  /** Reports whether the account has a usable offline cache. */
  onCacheStatus?: (accountId: string, hasCache: boolean) => void;
  /** Reports cache-derived category counts for the missing-category UI. */
  onCacheCategoryCounts?: (
    accountId: string,
    counts: Map<NotificationCategory, number>,
    timestamp?: number,
  ) => void;
  fetchImpl?: (partition: string, url: string, init: RequestInit) => Promise<Response>;
  pollerFactory?: (
    accountId: string,
    partition: string,
    callback: AtomPollCallback,
  ) => AtomFeedPoller;
  onPollResult?: (event: MailboxPollEvent) => void;
}

/**
 * Mailbox source orchestrating the feed, the local cache,
 * direct sync mutations, and universal sync nudges.
 */
export class HybridFeedSource implements MailboxSource {
  public readonly accountId: string;
  private readonly options: HybridFeedSourceOptions;
  private readonly ledger: UnreadLedger;
  private readonly poller: AtomFeedPoller;
  private readonly threadDriver: ThreadActionDriver;
  private readonly changeListeners = new Set<(event: MailboxChangeEvent) => void>();
  /** One re-read loop per account, so a burst of hints cannot stack them. */
  private hintReadInFlight = false;

  constructor(accountId: string, options: HybridFeedSourceOptions = {}) {
    this.accountId = accountId;
    this.options = options;
    this.ledger = new UnreadLedger(options.notificationSettings);

    const partition =
      options.partition ??
      options.getAccountContext?.(accountId)?.partition ??
      `persist:magimail_account_${accountId}`;

    const syncDriver = new SyncThreadActionDriver({
      getAccountContext: (accId) =>
        this.options.getAccountContext?.(accId) ??
        (this.options.partition ? { partition: this.options.partition } : undefined),
      existingView: (accId) => this.options.getView?.(accId),
      fetchImpl: this.options.fetchImpl,
    });
    const domDriver = new DomThreadActionDriver({
      wake:
        this.options.wake ??
        (async (accId) => {
          const view = this.options.getView?.(accId);
          if (!view || view.webContents.isDestroyed()) return undefined;
          return { view, release: () => {} };
        }),
      onActionHeld: this.options.onActionHeld,
    });
    this.threadDriver =
      this.options.threadActionDriver ?? new FallbackThreadActionDriver(syncDriver, domDriver);

    if (options.pollerFactory) {
      this.poller = options.pollerFactory(accountId, partition, (res) =>
        this.handlePollResult(res),
      );
    } else {
      this.poller = new AtomFeedPoller(
        accountId,
        partition,
        options.pollIntervalSeconds ?? 60,
        options.pollIntervalBatterySeconds ?? 180,
        (res) => this.handlePollResult(res),
      );
      if (options.notificationSettings) {
        this.poller.updateNotificationSettings(options.notificationSettings);
      }
      this.poller.start();
    }
  }

  public getUnreadCounts(): UnreadBreakdown {
    return this.ledger.getBreakdown();
  }

  public async getRecentMessages(limit = 20): Promise<TrayMessageItem[]> {
    const view = this.options.getView?.(this.accountId);
    if (view && !view.webContents.isDestroyed()) {
      try {
        const snapshot = await readCachedInboxData(view.webContents, limit);
        if (snapshot) {
          this.reportCache(snapshot);
          this.ledger.reconcileWithCache(snapshot.messages, Date.now(), snapshot.asOf);
        }
      } catch (err) {
        log.warn(`Failed to read cached inbox data for ${this.accountId}:`, err);
      }
    }

    const items = this.ledger.getRecentMessages(limit);
    if (items.length > 0) return items;

    // Before the first cache read or poll the ledger has nothing to show.
    return this.poller.getLatestEntries().slice(0, limit).map(atomMessageToTrayMessageItem);
  }

  public async triageThread(threadId: string, action: TriageAction): Promise<boolean> {
    // 0ms latency: update ledger optimistically, but not yet confirmed.
    this.ledger.recordLocalTriage(threadId, threadId, action);
    this.ledger.markLocalTriageInFlight(threadId, threadId);
    this.emitChange({
      addedMessageIds: [],
      removedMessageIds: [threadId],
      countChanged: true,
    });

    const success = await this.threadDriver.perform(undefined, this.accountId, threadId, action);
    if (success) {
      this.ledger.acceptLocalTriage(threadId, threadId, Date.now());
      await this.dispatchUniversalSyncNudge();
      return true;
    }

    // The optimistic row must not outlive a failed action.
    if (this.ledger.rollbackLocalTriage(threadId, threadId)) {
      this.emitChange({
        addedMessageIds: [],
        removedMessageIds: [],
        countChanged: true,
      });
    }
    return false;
  }

  public async refresh(): Promise<void> {
    await this.poller.pollNow();

    const view = this.options.getView?.(this.accountId);
    if (view && !view.webContents.isDestroyed()) {
      const before = this.ledger.getBreakdown().total;
      try {
        const snapshot = await readCachedInboxData(view.webContents, CACHE_HINT_MAX_ROWS);
        if (snapshot?.messages) {
          this.reportCache(snapshot);
          this.ledger.reconcileWithCache(snapshot.messages, Date.now(), snapshot.asOf);
        }
      } catch (err) {
        log.warn(`Cache refresh failed for ${this.accountId}:`, err);
      }
      this.emitIfCountChanged(before);
    }
  }

  public updateNotificationSettings(settings: Record<string, string>): void {
    this.ledger.updateNotificationSettings(settings);
    this.poller.updateNotificationSettings(settings);
    this.emitChange({
      addedMessageIds: [],
      removedMessageIds: [],
      countChanged: true,
    });
  }

  public setFocusAndMissingCategories(isFocused: boolean, missing: NotificationCategory[]): void {
    this.poller.setFocusAndMissingCategories(isFocused, missing);
  }

  public getPoller(): AtomFeedPoller {
    return this.poller;
  }

  public setPollIntervals(acSeconds: number, batterySeconds: number): void {
    this.poller.setIntervals(acSeconds, batterySeconds);
  }

  public requestImmediatePoll(): void {
    this.poller.requestImmediatePoll();
  }

  public stop(): void {
    this.poller.stop();
  }

  public forget(): void {
    this.destroy();
    clearPollerState(this.accountId);
  }

  public getArrivalCount(): number {
    return this.poller.getArrivalCount();
  }

  public isArrivalsIncomplete(): boolean {
    return this.ledger.getBreakdown().arrivalsIncomplete;
  }

  public async handleWindowWakeOrUnhide(): Promise<void> {
    await this.dispatchUniversalSyncNudge();
    await this.refresh();
  }

  /**
   * Reads the cache again shortly after a hint, until a read sees a change.
   *
   * The hint fires about 200ms after the click, and Gmail's write can land after
   * that, so the first read sometimes carries the old count and the badge waits
   * for the next hint or the next poll. Reading again is cheap: `getAll` over 500
   * rows measures 3ms and decoding every byte another 3ms, so three attempts cost
   * under 20ms spread over 200ms, against a 200ms debounce that is already paid.
   * A read that sees a change stops the loop.
   */
  public async handleMailboxChangeHint(): Promise<void> {
    this.poller.requestImmediatePoll();

    if (this.hintReadInFlight) return;
    const view = this.options.getView?.(this.accountId);
    if (!view || view.webContents.isDestroyed()) return;

    this.hintReadInFlight = true;
    try {
      for (let attempt = 0; attempt < CACHE_REREAD_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, CACHE_REREAD_INTERVAL_MS));
          if (view.webContents.isDestroyed()) return;
        }
        const before = this.ledger.getBreakdown().total;
        let moved = 0;
        try {
          const snapshot = await readCachedInboxData(view.webContents, CACHE_HINT_MAX_ROWS);
          if (snapshot?.messages) {
            this.reportCache(snapshot);
            moved = this.ledger.reconcileWithCache(
              snapshot.messages,
              Date.now(),
              snapshot.asOf,
            ).moved;
          }
        } catch {
          // Ignore cache failure; the poll already requested covers it.
        }
        this.emitIfCountChanged(before);
        if (moved > 0) return;
      }
    } finally {
      this.hintReadInFlight = false;
    }
  }

  private reportCache(snapshot: CachedInboxSnapshot): void {
    if (snapshot.stats?.reason === 'no-db') {
      this.options.onCacheStatus?.(this.accountId, false);
      return;
    }
    if (!snapshot.stats?.reason) {
      this.options.onCacheStatus?.(this.accountId, true);
      if (snapshot.categoryCounts.size > 0) {
        this.options.onCacheCategoryCounts?.(
          this.accountId,
          snapshot.categoryCounts,
          snapshot.asOf,
        );
      }
    }
  }

  private emitIfCountChanged(before: number): void {
    if (this.ledger.getBreakdown().total === before) return;
    this.emitChange({ addedMessageIds: [], removedMessageIds: [], countChanged: true });
  }

  public async dispatchUniversalSyncNudge(): Promise<void> {
    const view = this.options.getView?.(this.accountId);
    if (!view || view.webContents.isDestroyed()) return;
    await pressRefreshControl(view.webContents);
  }

  public onChanged(callback: (event: MailboxChangeEvent) => void): () => void {
    this.changeListeners.add(callback);
    return () => {
      this.changeListeners.delete(callback);
    };
  }

  public destroy(): void {
    this.changeListeners.clear();
    if (typeof this.poller.stop === 'function') {
      this.poller.stop();
    }
    if (typeof (this.poller as unknown as { destroy?: () => void }).destroy === 'function') {
      (this.poller as unknown as { destroy: () => void }).destroy();
    }
  }

  private async handlePollResult(result: AtomPollResult): Promise<void> {
    if (result.status === 'ok') {
      const pollerEntries = this.poller.getLatestEntries();
      const entries: AtomMessage[] =
        pollerEntries.length > 0 ? pollerEntries : (result.newMessages ?? []);

      const rawFullCount =
        result.rawFullCount ??
        (typeof this.poller.getLastFullCount === 'function'
          ? this.poller.getLastFullCount()
          : null);

      const delta = this.ledger.reconcileWithAtom(
        entries,
        rawFullCount,
        Date.now(),
        result.categoryCounts,
        result.sourceAsOf,
      );

      if (delta.countChanged || delta.added.length > 0 || delta.removed.length > 0) {
        await this.dispatchUniversalSyncNudge();
        this.emitChange({
          addedMessageIds: delta.added,
          removedMessageIds: delta.removed,
          countChanged: delta.countChanged,
        });
      }
    }

    this.options.onPollResult?.({
      accountId: result.accountId,
      status: result.status ?? 'ok',
      categoryCounts: result.categoryCounts,
      newMessages: result.newMessages,
      newArrivalCount: result.newArrivalCount,
      arrivalsIncomplete: result.arrivalsIncomplete,
    });
  }

  private emitChange(delta: {
    addedMessageIds: string[];
    removedMessageIds: string[];
    countChanged: boolean;
  }): void {
    const unread = this.ledger.getBreakdown();
    const event: MailboxChangeEvent = {
      accountId: this.accountId,
      unread,
      recentMessages: this.ledger.getRecentMessages(20),
      delta,
    };

    for (const listener of this.changeListeners) {
      try {
        listener(event);
      } catch (err) {
        log.error(`Mailbox change listener failed for ${this.accountId}:`, err);
      }
    }
  }
}
