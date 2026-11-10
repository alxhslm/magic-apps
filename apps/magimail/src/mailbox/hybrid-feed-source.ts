import type { WebContentsView } from 'electron';
import { viewIsAlive } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import {
  AtomFeedPoller,
  atomMessageToTrayMessageItem,
  clearPollerState,
  pruneOrphanAtomState,
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
import { extractVerificationCode } from '../verification-code.js';
import type {
  MailboxChangeEvent,
  MailboxPollEvent,
  MailboxSource,
  TrayMessageItem,
  TriageAction,
  UnreadBreakdown,
  VerificationCodeItem,
} from './types.js';
import { UnreadLedger } from './unread-ledger.js';
import { saveUnreadCounts, deleteStoredUnreadCounts } from './unread-count-store.js';

/** How many times a hint re-reads the cache, and how far apart. */
/** How long to wait before storing changed counts. */
const COUNTS_PERSIST_DELAY_MS = 3000;

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
  /** One write of the stored counts at a time. */
  private countPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private notificationSettings: Record<string, string> = {};
  /** Ledger revision number at the time of the last emitted change event. */
  private lastEmittedRevision: number | null = null;

  constructor(accountId: string, options: HybridFeedSourceOptions = {}) {
    this.accountId = accountId;
    this.options = options;
    this.notificationSettings = options.notificationSettings ?? {};
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
          if (!viewIsAlive(view)) return undefined;
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

  public getUnreadCountFor(categories: ReadonlySet<NotificationCategory>): number {
    return this.ledger.getUnreadCountFor(categories);
  }

  public async getRecentMessages(limit = 20): Promise<TrayMessageItem[]> {
    const view = this.options.getView?.(this.accountId);
    if (viewIsAlive(view)) {
      try {
        const snapshot = await readCachedInboxData(view.webContents, limit);
        if (snapshot) {
          this.reportCache(snapshot);
          this.ledger.reconcileWithCache(snapshot.messages, Date.now(), snapshot.asOf);
        }
      } catch (err) {
        log.warn(`Failed to read cached inbox data for ${this.accountId}:`, err);
      }
      this.emitIfStateChanged();
    }

    const items = this.ledger.getRecentMessages(limit);
    if (items.length > 0) return items;

    // Before the first cache read or poll the ledger has nothing to show.
    return this.poller.getLatestEntries().slice(0, limit).map(atomMessageToTrayMessageItem);
  }

  public async getLatestVerificationCode(maxAgeMs?: number): Promise<VerificationCodeItem | null> {
    const fromLedger = this.ledger.getLatestVerificationCode(this.accountId, maxAgeMs);
    if (fromLedger) return fromLedger;
    if (this.ledger.getBreakdown().hasState) return null;

    const entries = this.poller.getLatestEntries();
    const now = Date.now();
    const limitAge = maxAgeMs ?? 15 * 60 * 1000;
    for (const msg of entries) {
      const time = msg.modified ? new Date(msg.modified).getTime() : now;
      if (now - time > limitAge) continue;
      const extracted = extractVerificationCode(msg.subject, msg.snippet, msg.from);
      if (extracted) {
        return {
          code: extracted.code,
          service: extracted.service,
          subject: msg.subject || '',
          from: msg.from || '',
          messageId: msg.id,
          threadId: msg.threadId,
          accountId: this.accountId,
          receivedAt: time,
        };
      }
    }
    return null;
  }

  public async triageThread(threadId: string, action: TriageAction): Promise<boolean> {
    // Triage leaves no other trace: the window does not move and a refusal rolls the
    // ledger back without a word, so the line has to say it was asked for.
    log.info(`Triage ${action} on ${this.accountId}: thread=${threadId}`);

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
    const rolledBack = this.ledger.rollbackLocalTriage(threadId, threadId);
    log.warn(
      `Triage ${action} on ${this.accountId} failed for thread=${threadId}; ` +
        (rolledBack ? 'rolled back' : 'no pending row'),
    );
    if (rolledBack) {
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
    if (viewIsAlive(view)) {
      try {
        const snapshot = await readCachedInboxData(view.webContents, CACHE_HINT_MAX_ROWS);
        if (snapshot?.messages) {
          this.reportCache(snapshot);
          this.ledger.reconcileWithCache(snapshot.messages, Date.now(), snapshot.asOf);
        }
      } catch (err) {
        log.warn(`Cache refresh failed for ${this.accountId}:`, err);
      }
      this.emitIfStateChanged();
    }
  }

  public updateNotificationSettings(settings: Record<string, string>): void {
    this.notificationSettings = settings;
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
    forgetMailboxAccount(this.accountId);
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
    if (!viewIsAlive(view)) return;

    this.hintReadInFlight = true;
    try {
      for (let attempt = 0; attempt < CACHE_REREAD_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, CACHE_REREAD_INTERVAL_MS));
          if (!viewIsAlive(view)) return;
        }
        let moved = 0;
        try {
          const snapshot = await readCachedInboxData(view.webContents, CACHE_HINT_MAX_ROWS);
          if (snapshot?.messages) {
            this.reportCache(snapshot);
            const res = this.ledger.reconcileWithCache(
              snapshot.messages,
              Date.now(),
              snapshot.asOf,
            );
            moved = res.moved;
          }
        } catch {
          // Ignore cache failure; the poll already requested covers it.
        }
        this.emitIfStateChanged();
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

  public getRevision(): number {
    return this.ledger.getRevision();
  }

  private emitIfStateChanged(delta?: {
    addedMessageIds?: string[];
    removedMessageIds?: string[];
    countChanged?: boolean;
  }): boolean {
    const currentRevision = this.ledger.getRevision();
    const hasState = this.ledger.getBreakdown().hasState;
    if (this.lastEmittedRevision === currentRevision) return false;
    if (this.lastEmittedRevision === null && !hasState) return false;

    this.emitChange({
      addedMessageIds: delta?.addedMessageIds ?? [],
      removedMessageIds: delta?.removedMessageIds ?? [],
      countChanged: delta?.countChanged ?? true,
    });
    this.persistCountsSoon();
    return true;
  }

  /**
   * Stores this account's counts shortly after they settle.
   *
   * The counts are this source's state, so it keeps them between launches rather
   * than leaving it to a caller. A launch draws the tray before anything is
   * polled, and the store is what stops it starting at zero. Sealed through
   * `unread-count-store`; throttled because a poll changes the count every few
   * seconds.
   */
  private persistCountsSoon(): void {
    if (this.countPersistTimer) return;
    this.countPersistTimer = setTimeout(() => {
      this.countPersistTimer = null;
      const breakdown = this.ledger.getBreakdown();
      const enabled = new Set(
        (['primary', 'updates', 'promotions', 'social', 'forums'] as const).filter(
          (category) => this.notificationSettings[category] !== 'off',
        ),
      );
      saveUnreadCounts(this.accountId, {
        total: breakdown.total,
        badge: this.ledger.getUnreadCountFor(enabled),
      });
    }, COUNTS_PERSIST_DELAY_MS);
    this.countPersistTimer.unref?.();
  }

  public async dispatchUniversalSyncNudge(): Promise<void> {
    const view = this.options.getView?.(this.accountId);
    if (!viewIsAlive(view)) return;
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

      const breakdown = this.ledger.getBreakdown();
      const needsInitialEmit = this.lastEmittedRevision === null && breakdown.hasState;
      const revisionChanged =
        this.lastEmittedRevision !== null && this.lastEmittedRevision !== this.ledger.getRevision();

      if (
        needsInitialEmit ||
        revisionChanged ||
        delta.added.length > 0 ||
        delta.removed.length > 0
      ) {
        this.emitChange({
          addedMessageIds: delta.added,
          removedMessageIds: delta.removed,
          countChanged: delta.countChanged || needsInitialEmit,
        });
        await this.dispatchUniversalSyncNudge();
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
    this.lastEmittedRevision = this.ledger.getRevision();
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

/**
 * Forgets and clears all persisted mailbox state (unread counts and seen-id atom state)
 * for an account that has been removed.
 */
export function forgetMailboxAccount(accountId: string): void {
  clearPollerState(accountId);
  deleteStoredUnreadCounts(accountId);
}

/**
 * Sweeps all persisted mailbox state on disk (atom-state files) on startup,
 * deleting records for accounts that are no longer configured.
 */
export function sweepOrphanedMailboxState(activeAccountIds: readonly string[]): void {
  pruneOrphanAtomState(activeAccountIds);
}
