import type { WebContentsView } from 'electron';
import { createLogger } from '@magimail/core/logger';
import {
  AtomFeedPoller,
  atomMessageToTrayMessageItem,
  type AtomMessage,
  type AtomPollCallback,
  type AtomPollResult,
  type NotificationCategory,
} from '../atom-poller.js';
import { readCachedInboxData } from '../gmail-cache-reader.js';
import { DomThreadActionDriver } from '../thread-actions/dom-driver.js';
import { FallbackThreadActionDriver } from '../thread-actions/fallback-driver.js';
import { pressRefreshControl, SyncThreadActionDriver } from '../thread-actions/sync-driver.js';
import type { ThreadActionDriver } from '../thread-actions/types.js';
import type {
  MailboxChangeEvent,
  MailboxSource,
  TrayMessageItem,
  TriageAction,
  UnreadBreakdown,
} from './types.js';
import { UnreadLedger } from './unread-ledger.js';

const log = createLogger('HybridFeedSource');

export interface HybridFeedSourceOptions {
  getView?: (accountId: string) => WebContentsView | undefined;
  getAccountContext?: (accountId: string) => { partition: string } | undefined;
  partition?: string;
  notificationSettings?: Record<string, string>;
  /** Overrides the direct-then-DOM driver, used by tests. */
  threadActionDriver?: ThreadActionDriver;
  /** Wakes the account's view for the DOM fallback. */
  wake?: (accountId: string) => Promise<{ view: WebContentsView; release: () => void } | undefined>;
  /** A press the view refused, to retry once the editor is free. */
  onActionHeld?: (accountId: string, threadId: string, action: TriageAction) => void;
  fetchImpl?: (partition: string, url: string, init: RequestInit) => Promise<Response>;
  pollerFactory?: (
    accountId: string,
    partition: string,
    callback: AtomPollCallback,
  ) => AtomFeedPoller;
  onPollResult?: (result: AtomPollResult) => void;
}

/**
 * Mailbox source orchestrating the Atom feed, offline IndexedDB cache (_xdb),
 * direct sync mutations, and universal sync nudges.
 */
export class HybridFeedSource implements MailboxSource {
  public readonly accountId: string;
  private readonly options: HybridFeedSourceOptions;
  private readonly ledger: UnreadLedger;
  private readonly poller: AtomFeedPoller;
  private readonly threadDriver: ThreadActionDriver;
  private readonly changeListeners = new Set<(event: MailboxChangeEvent) => void>();
  private lastKnownRecent: TrayMessageItem[] = [];

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
      this.poller = new AtomFeedPoller(accountId, partition, 30, (res) =>
        this.handlePollResult(res),
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
        if (snapshot && snapshot.messages && snapshot.messages.length > 0) {
          this.ledger.reconcileWithCache(snapshot.messages, Date.now(), snapshot.asOf);
          this.lastKnownRecent = snapshot.messages.slice(0, limit);
          return this.lastKnownRecent;
        }
      } catch (err) {
        log.warn(`Failed to read cached inbox data for ${this.accountId}:`, err);
      }
    }

    const entries = this.poller.getLatestEntries();
    if (entries.length > 0) {
      const items = entries.slice(0, limit).map(atomMessageToTrayMessageItem);
      this.lastKnownRecent = items;
      return items;
    }

    return this.lastKnownRecent;
  }

  public async triageThread(threadId: string, action: TriageAction): Promise<boolean> {
    // 0ms latency: update ledger optimistically
    this.ledger.recordLocalTriage(threadId, threadId, action);
    this.emitChange({
      addedMessageIds: [],
      removedMessageIds: [threadId],
      countChanged: true,
    });

    const success = await this.threadDriver.perform(undefined, this.accountId, threadId, action);
    if (success) {
      await this.dispatchUniversalSyncNudge();
    }
    return success;
  }

  public async refresh(): Promise<void> {
    await this.poller.pollNow();

    const view = this.options.getView?.(this.accountId);
    if (view && !view.webContents.isDestroyed()) {
      try {
        const snapshot = await readCachedInboxData(view.webContents, 20);
        if (snapshot?.messages) {
          this.ledger.reconcileWithCache(snapshot.messages, Date.now(), snapshot.asOf);
        }
      } catch (err) {
        log.warn(`Cache refresh failed for ${this.accountId}:`, err);
      }
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

  public async handleMailboxChangeHint(): Promise<void> {
    const view = this.options.getView?.(this.accountId);
    if (view && !view.webContents.isDestroyed()) {
      try {
        const snapshot = await readCachedInboxData(view.webContents, 20);
        if (snapshot?.messages) {
          this.ledger.reconcileWithCache(snapshot.messages, Date.now(), snapshot.asOf);
        }
      } catch {
        // Ignore cache failure
      }
    }
    this.poller.requestImmediatePoll();
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
          : null) ??
        result.totalUnread;

      const delta = this.ledger.reconcileWithAtom(
        entries,
        rawFullCount,
        Date.now(),
        result.totalUnread,
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

    this.options.onPollResult?.(result);
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
      recentMessages: this.lastKnownRecent,
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
