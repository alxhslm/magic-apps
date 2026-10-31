import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  webFrameMain,
  type WebFrameMain,
  session,
  shell,
  dialog,
  clipboard,
} from 'electron';
import {
  type AccountConfig,
  TOOLBAR_HEIGHT,
  calculateAggregateBadge,
  calculateAggregateUnread,
  updateAccountUnread,
  updateAccountAuth,
  configureGoogleSession,
  isNetworkLoadFailure,
  offlinePageDataUrl,
  DOM_DRIVE_PREAMBLE,
  getGoogleSurfaceColor,
  RendererPool,
  SUSPEND_NEVER,
  viewIsAlive,
} from '@magimail/core';
import {
  GMAIL_LOGIN_URL,
  type DomUnreadReport,
  type NotificationCategory,
  IPC_CHANNELS,
} from './constants.js';
import {
  getGmailCustomCss,
  getGmailLightModeCss,
  getGmailDarkModeCss,
  getSubframeDarkModeCss,
  getSubframeLightModeCss,
  getHideAdsCss,
  getHideSidebarCss,
  injectGmailStyles,
} from './css.js';
import { createComposeWindowOptions } from './window.js';
import { getCssOverride } from './css-override.js';
import { uiString } from './strings.js';
import { updateDockBadge, type ArrivalBadgeState } from './dock.js';
import { openDetachedThreadWindow } from './compose.js';
import { loadAccounts, saveAccounts, createNewAccount } from './account-store.js';
import { loadSettings, saveSetting } from './settings-store.js';
import { pressRefreshControl } from './thread-actions/sync-driver.js';
import {
  type MailboxSource,
  type MailboxChangeEvent,
  type MailboxPollEvent,
  HybridFeedSource,
} from './mailbox/index.js';
import {
  attachNativeToolbar,
  updateNativeToolbarAccounts,
  setNativeToolbarItemEnabled,
  showNativeSharingPicker,
  setNativeToolbarShareUrl,
} from './native-toolbar.js';
import { type ComposeFields, populateComposeFields } from './compose-fields.js';
import { DOM_ACTION_MAP, domAction } from './dom-labels.js';
import { createShareTempDir, removeShareTempDir, writeIntoShareTempDir } from './share-staging.js';
import { observeGmailSyncState } from './gmail-sync-state.js';
import { type FocusFilterState } from './focus-filter-manager.js';
import { createLogger, redactUrl } from '@magimail/core/logger';
import { type ThreadActionDriver, type TriageAction } from './thread-actions/index.js';

const composeLog = createLogger('Compose');
const log = createLogger('Accounts');

/** Re-exported for this app's callers. */
export { SUSPEND_NEVER };

/** Height of the native category notification banner placed beneath the toolbar. */
export const CATEGORY_BANNER_HEIGHT = 34;

/**
 * Toolbar items that only make sense with a message open.
 *
 * Reply, Reply All and Forward act on an open message, so they are greyed out
 * on a list view alongside Print and Share. Archive, Delete and Mark Read stay
 * enabled because they act on a list selection too. `replyGroup` is the
 * segmented Reply/Reply All/Forward group, which carries its own identifier.
 */
/** How long to wait before writing changed unread counts to the accounts file. */
const UNREAD_PERSIST_DELAY_MS = 3000;

const THREAD_ONLY_TOOLBAR_ITEMS = ['print', 'share'] as const;

/**
 * The reply controls, keyed by toolbar item id.
 *
 * These are enabled from what the open thread actually renders rather than from
 * the URL, because presence varies per thread: Gmail omits reply-to-all when a
 * message has a single recipient, and a lit-up button that silently does
 * nothing is worse than a greyed one. Gmail renders the per-message control as
 * `span[role="link"]` with no `aria-label`, no `data-tooltip` and no `act`, so a
 * localised label is the only handle; the map sets `order: 'last'` so the newest
 * message's control is the one resolved (see `docs/shared/dom-labels.md`).
 */
const REPLY_CONTROLS = ['reply', 'replyAll', 'forward'] as const;
type ReplyControlId = (typeof REPLY_CONTROLS)[number];

/**
 * Gmail's read/unread toggle in the message list.
 *
 * Gmail renders both `div[act="1"]` (Mark as read) and `div[act="2"]` (Mark as
 * unread) and lays out only the one the selection's state calls for, so
 * whichever is on screen *is* the toggle. A thread only ever offers `act="2"`,
 * because opening a thread is what marks it read. Both numbers are hand-authored
 * by Gmail and read at runtime, so the map holds them as hooks.
 */
const READ_TOGGLE_ACTIONS = ['markUnread', 'markRead'] as const;

/** The segmented Reply/Reply to all/Forward group, enabled if any member is. */
const REPLY_GROUP_TOOLBAR_ITEM = 'replyGroup';

/**
 * The categories a display surface counts, given the notification settings.
 *
 * The mailbox source reports per-category facts and answers a query; which
 * categories a surface includes is decided here, because this class owns both the
 * settings and the accounts. `off` means "do not pull attention", which for the
 * dock badge means "do not count"; the menu bar and widgets ask for everything.
 */
function countedCategories(
  notifications: Record<string, string> | undefined,
): Set<NotificationCategory> {
  const all: NotificationCategory[] = ['primary', 'updates', 'promotions', 'social', 'forums'];
  return new Set(all.filter((cat) => notifications?.[cat] !== 'off'));
}

function setThreadOnlyItemsEnabled(enabled: boolean): void {
  for (const id of THREAD_ONLY_TOOLBAR_ITEMS) {
    setNativeToolbarItemEnabled(id, enabled);
  }
}

function setReplyControlsEnabled(present: Record<ReplyControlId, boolean>): void {
  for (const id of REPLY_CONTROLS) {
    setNativeToolbarItemEnabled(id, present[id]);
  }

  // The group is its own toolbar item, so it needs setting separately from its
  // members: off only when none of them is available.
  setNativeToolbarItemEnabled(
    REPLY_GROUP_TOOLBAR_ITEM,
    present.reply || present.replyAll || present.forward,
  );
}

/** Everything `performThreadAction` can be asked to do with a thread. */
export type ThreadAction = 'open' | 'archive' | 'trash' | 'markRead' | 'markUnread';

/**
 * The actions, and the subset that leaves the window where it is.
 *
 * Written once because four surfaces reach `performThreadAction`: a
 * `magimail://thread/` link, the menu bar popover's open and triage rows, and a
 * notification's buttons. Each used to carry its own hand-written list, and they had
 * already drifted apart, so adding an action meant remembering four places and
 * forgetting one failed silently.
 *
 * Only `open` asks to look at something, which is what makes it the odd one out: it
 * raises the window and changes the account on screen, and triage must not.
 */
export const THREAD_ACTIONS: readonly ThreadAction[] = [
  'open',
  'archive',
  'trash',
  'markRead',
  'markUnread',
];

export const TRIAGE_ACTIONS: readonly ThreadAction[] = THREAD_ACTIONS.filter((a) => a !== 'open');

/** Narrows an untrusted string, from a URL or an RPC, to an action worth running. */
export function asThreadAction(
  value: unknown,
  allowed: readonly ThreadAction[] = THREAD_ACTIONS,
): ThreadAction | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as ThreadAction)
    : undefined;
}

/**
 * A triage action pressed while the view would not leave what it was showing.
 *
 * Held rather than dropped: a banner button that does nothing is the same class of
 * failure as a notification that never arrives, and the usual reason for the refusal
 * is an open compose, which is a normal thing to be doing when mail arrives.
 *
 * Opening is deliberately not held. It asks to look at something now, and raising the
 * window five minutes later, over whatever the user moved on to, is worse than not
 * moving at all.
 */
interface QueuedMailAction {
  accountId: string;
  messageId: string;
  action: Exclude<ThreadAction, 'open'>;
  queuedAt: number;
}

/**
 * Deletes partition directories no configured account uses.
 *
 * An account id is a timestamp, so a removed account's partition is orphaned: nothing ever
 * signs in to it again, and its cookies are a Google session left on disk for the life of
 * the install. `removeAccount` clears the one it just removed; this catches a crash between
 * the two, and runs before any timestamp-named session is created so nothing holds the
 * files open. The fixed `magimail_personal` and `magimail_work` partitions are left alone.
 */
function pruneOrphanPartitions(partitions: readonly string[]): void {
  const keep = new Set(partitions.map((p) => p.replace(/^persist:/, '')));
  const root = path.join(app.getPath('userData'), 'Partitions');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // No Partitions directory yet: a fresh install.
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('magimail_account_')) continue;
    if (keep.has(entry.name)) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      log.info(`Pruned the partition of a removed account: ${entry.name}`);
    } catch (err) {
      log.warn(`Could not prune the partition ${entry.name}:`, err);
    }
  }
}

export class AccountsManager {
  private accounts: AccountConfig[] = loadAccounts();
  private activeAccountId: string = this.accounts[0]?.id ?? '';
  /** The account a cold-launch link named, resolved in `initialize()`. */
  private requestedInitialAccountId?: string;
  private readonly pool: RendererPool<AccountConfig, WebContentsView>;
  private mainWindow: BaseWindow;
  private preloadPath: string;
  private themeManager?: import('./theme-manager.js').ThemeManager;
  private earlyCssKeys: Map<WebContentsView, string> = new Map();
  private signInDetected: Set<string> = new Set();
  private pendingComposeResolve: ((win: import('electron').BrowserWindow) => void) | null = null;
  private focusFilter: FocusFilterState | null = null;
  /** Actions queued while an active editor or compose window is busy. */
  private mailActionQueue: Map<string, QueuedMailAction> = new Map();
  private mailActionTimer: ReturnType<typeof setInterval> | null = null;
  /** Tracks URLs that failed loading due to network/offline errors, so reconnect reloads them. */
  private failedOfflineUrls: Map<string, string> = new Map();
  public onAccountsChanged?: () => void;
  public onGmailSignIn?: (accountId: string) => void;
  public onUnreadChanged?: (accounts: AccountConfig[], totalUnread: number) => void;
  public onMissingCategoriesChanged?: (accountId: string, missing: NotificationCategory[]) => void;
  public onAbsentCategoriesChanged?: (accountId: string, absent: NotificationCategory[]) => void;
  public onAccountSwitched?: (accountId: string) => void;
  private categoryBannerView: WebContentsView | null = null;
  private isCategoryBannerVisible = false;
  private bannerShowTimer: ReturnType<typeof setTimeout> | null = null;
  /** Settling delay before displaying banner (0ms now that isLoaded is detected from DOM). */
  public bannerSettleDelayMs = 0;
  private dismissedBannersThisSession = new Set<string>();
  private offlineCacheAvailableByAccount: Map<string, boolean> = new Map();
  private currentBannerType: 'categories' | 'offlineMail' = 'offlineMail';
  private accountsWithCategoriesObserved = new Set<string>();
  private unreadPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private domReports: Map<string, DomUnreadReport> = new Map();
  private mailboxSources: Map<string, MailboxSource> = new Map();
  public onPollResult?: (event: MailboxPollEvent) => void;
  /**
   * The latest count seen for each category, from the sidebar or the feed,
   * whichever reported it last. Neither covers all five on its own, so a
   * category missing from both reads as its last count rather than as zero.
   */
  private lastKnownCategoryCounts: Map<string, Map<NotificationCategory, number>> = new Map();
  /**
   * Unhandled new arrivals per account, as last reported by its poller.
   *
   * Only the feed can answer this, so unlike the unread count it is never
   * blended with the sidebar observer — the DOM knows what is unread, not what
   * arrived. That costs the `newArrivals` badge mode the observer's instant
   * update, but a mailbox change hint re-polls within a second of the click.
   */
  private arrivalsByAccount: Map<string, number> = new Map();
  /**
   * Accounts whose last feed response was cut short, so their arrival count may
   * be short too. One such account makes the whole badge a floor rather than a
   * total — the number spans every focused account, and a "+" on any part of it
   * is a "+" on the sum.
   */
  private arrivalsIncompleteByAccount: Set<string> = new Set();
  private missingCategoriesByAccount: Map<string, NotificationCategory[]> = new Map();
  private isWindowFocused = true;
  /** Stops an older reply-control scan from overwriting a newer one. */
  private replyControlScan = 0;

  public onThreadStateChanged?: (isThread: boolean) => void;
  public onHistoryChanged?: () => void;
  private readonly threadActionDriver?: ThreadActionDriver;

  constructor(
    mainWindow: BaseWindow,
    preloadPath: string,
    themeManager?: import('./theme-manager.js').ThemeManager,
    threadActionDriver?: ThreadActionDriver,
  ) {
    this.mainWindow = mainWindow;
    this.preloadPath = preloadPath;
    this.themeManager = themeManager;
    this.threadActionDriver = threadActionDriver;

    this.pool = new RendererPool<AccountConfig, WebContentsView>(
      {
        window: () => this.mainWindow,
        accountFor: (accountId) => this.accounts.find((a) => a.id === accountId),
        activeAccountId: () => this.activeAccountId,
        createView: (account) => this.createAccountView(account),
        attach: (accountId, view) => {
          if (typeof view.setVisible === 'function') {
            view.setVisible(true);
          }
          if (!this.mainWindow.contentView.children.includes(view)) {
            this.mainWindow.contentView.addChildView(view);
            log.info(`Attached view for account ${accountId} (${this.pool.attachedSummary()})`);
          }
        },
        detach: (accountId, view) => {
          // Suspending every view on window close runs after the window is gone, and
          // its contentView throws once destroyed. The view is still closed either way;
          // there is simply nothing left to take it off.
          if (this.windowIsGone()) return;
          if (this.mainWindow.contentView.children.includes(view)) {
            this.mainWindow.contentView.removeChildView(view);
            log.info(`Detached view for account ${accountId} (${this.pool.attachedSummary()})`);
          }
        },
        // The two things Magimail holds per view: the key of the stylesheet injected into
        // it, and the unread report it produced. Keeping a report with no page behind it
        // would pin the count to whatever Gmail last showed, with no renderer left to
        // correct it.
        onRelease: (accountId, view) => {
          this.earlyCssKeys.delete(view);
          this.domReports.delete(accountId);
        },
        rememberUrl: (url) => (url.startsWith('https://mail.google.com') ? url : undefined),
      },
      {
        suspendDelayMinutes: loadSettings().inactiveAccountSuspendMinutes,
        log,
      },
    );

    for (const account of this.accounts) {
      this.mailboxSources.set(account.id, this.createMailboxSource(account));
    }
  }

  private createMailboxSource(account: AccountConfig): MailboxSource {
    const settings = loadSettings();
    const source = new HybridFeedSource(account.id, {
      getView: (accId) => this.pool.view(accId),
      getAccountContext: (accId) => {
        const acc = this.accounts.find((a) => a.id === accId);
        return acc ? { partition: acc.partition } : undefined;
      },
      partition: account.partition,
      notificationSettings: settings.notifications || {},
      pollIntervalSeconds: settings.pollIntervalSeconds,
      pollIntervalBatterySeconds: settings.pollIntervalBatterySeconds,
      threadActionDriver: this.threadActionDriver,
      wake: (accId) => this.wakeAccountForAction(accId),
      onActionHeld: (accId, threadId, action) => {
        this.queueMailAction({
          accountId: accId,
          messageId: threadId,
          action,
          queuedAt: Date.now(),
        });
      },
      onCacheStatus: (accId, hasCache) => this.handleOfflineCacheStatus(accId, hasCache),
      onCacheCategoryCounts: (accId, counts) => this.handleCacheCategoryCounts(accId, counts),
      onPollResult: (result) => {
        if (result.status === 'ok') {
          this.setAccountAuthRequired(result.accountId, false);
          this.handlePollMetadata(
            result.accountId,
            result.categoryCounts,
            result.newArrivalCount,
            result.arrivalsIncomplete,
          );
        } else if (result.status === 'auth_required') {
          this.setAccountAuthRequired(result.accountId, true);
        }
        this.onPollResult?.(result);
      },
    });

    source.onChanged((event) => {
      this.handleMailboxChange(event);
    });

    return source;
  }

  private handleMailboxChange(event: MailboxChangeEvent): void {
    // The source emits only when the mailbox changed. Do not second-guess it with
    // a count comparison: a row can change while the total stays the same.
    const badgeTotal =
      this.getMailboxSource(event.accountId)?.getUnreadCountFor(
        countedCategories(loadSettings().notifications),
      ) ?? event.unread.total;
    this.accounts = updateAccountUnread(
      this.accounts,
      event.accountId,
      event.unread.total,
      badgeTotal,
    );
    const focused = this.getFocusedAccounts();
    const total = calculateAggregateUnread(focused);
    updateDockBadge(calculateAggregateBadge(focused), this.getFocusedArrivals());
    this.notifyToolbar();
    this.onUnreadChanged?.(focused, total);
    this.persistUnreadCountsSoon();
  }

  /**
   * Writes the current counts to the accounts file, shortly after they settle.
   *
   * The file already carries `unreadCount` per account and startup reads it to
   * draw the tray before anything is polled, but nothing ever wrote it back: the
   * only saves were account edits, so every launch began from whatever the count
   * was when the account was last added, which was usually zero. Throttled
   * because a poll changes the count every few seconds and the file is small but
   * not free.
   */
  private persistUnreadCountsSoon(): void {
    if (this.unreadPersistTimer) return;
    this.unreadPersistTimer = setTimeout(() => {
      this.unreadPersistTimer = null;
      saveAccounts(this.accounts);
    }, UNREAD_PERSIST_DELAY_MS);
    this.unreadPersistTimer.unref?.();
  }

  public getMailboxSource(accountId: string): MailboxSource | undefined {
    return this.mailboxSources.get(accountId);
  }

  public getMailboxSources(): Map<string, MailboxSource> {
    return this.mailboxSources;
  }

  public setPollIntervals(acSeconds: number, batterySeconds: number): void {
    for (const source of this.mailboxSources.values()) {
      source.setPollIntervals(acSeconds, batterySeconds);
    }
  }

  public requestImmediatePoll(): void {
    for (const source of this.mailboxSources.values()) {
      source.requestImmediatePoll();
    }
  }

  public stopMailboxSources(): void {
    for (const source of this.mailboxSources.values()) {
      source.stop();
    }
  }

  public updateNotificationSettings(settings: Record<string, string>): void {
    for (const source of this.mailboxSources.values()) {
      source.updateNotificationSettings(settings);
    }
  }

  public getAccounts(): AccountConfig[] {
    return [...this.accounts];
  }

  /**
   * Every account, always.
   *
   * The switcher and the Accounts menu are how you navigate between mailboxes,
   * so a Focus Filter never removes a row from them — losing the way back to an
   * inbox is a worse failure than seeing one you are currently ignoring. Focus
   * state reaches those surfaces as emphasis instead, via `isExcludedByFocus`
   * and `isDisabledByFocus`.
   */
  public getVisibleAccounts(): AccountConfig[] {
    return [...this.accounts];
  }

  /**
   * Only the accounts the active Focus Filter includes.
   *
   * This is the list for surfaces whose job is to pull attention — the menu bar
   * popover, the widgets and the dock badge. Suppressing them is the point of a
   * Focus Filter, and none of them is a way to reach a mailbox, so dropping a
   * row costs nothing.
   */
  /**
   * Adopt an account's arrival count from its poller's saved state.
   *
   * Called as the poller is constructed, before it has fetched anything, so the
   * dock badge starts from the number on disk instead of from zero.
   */
  public seedArrivalCount(accountId: string, count: number): void {
    this.arrivalsByAccount.set(accountId, count);
    const focused = this.getFocusedAccounts();
    updateDockBadge(calculateAggregateBadge(focused), this.getFocusedArrivals());
  }

  /** New arrivals across the accounts the Focus Filter includes, and whether the sum may be short. */
  private getFocusedArrivals(): ArrivalBadgeState {
    let count = 0;
    let incomplete = false;
    for (const account of this.getFocusedAccounts()) {
      count += this.arrivalsByAccount.get(account.id) ?? 0;
      if (this.arrivalsIncompleteByAccount.has(account.id)) incomplete = true;
    }
    return { count, incomplete };
  }

  public getFocusedAccounts(): AccountConfig[] {
    if (this.focusFilter && this.focusFilter.activeAccountIds.length > 0) {
      return this.accounts.filter((a) => this.focusFilter!.activeAccountIds.includes(a.id));
    }
    return [...this.accounts];
  }

  /** Whether the active Focus Filter excludes this account. */
  public isExcludedByFocus(accountId: string): boolean {
    if (!this.focusFilter || this.focusFilter.activeAccountIds.length === 0) return false;
    return !this.focusFilter.activeAccountIds.includes(accountId);
  }

  /** Whether this account is excluded *and* the filter disables rather than de-emphasises. */
  public isDisabledByFocus(accountId: string): boolean {
    if (!this.focusFilter?.disableExcludedAccounts) return false;
    return this.isExcludedByFocus(accountId);
  }

  public getFocusFilter(): FocusFilterState | null {
    return this.focusFilter ? { ...this.focusFilter } : null;
  }

  public setFocusFilter(filter: FocusFilterState | null): void {
    this.focusFilter =
      filter && filter.activeAccountIds.length > 0
        ? {
            activeAccountIds: [...filter.activeAccountIds],
            disableExcludedAccounts: Boolean(filter.disableExcludedAccounts),
            isFilterActive: true,
          }
        : null;

    // Only a *disabled* account forces a move. Being merely de-emphasised must
    // never yank the window out from under someone mid-read, which is what
    // switching on any exclusion used to do.
    if (this.isDisabledByFocus(this.activeAccountId)) {
      const reachable = this.accounts.filter((a) => !this.isDisabledByFocus(a.id));
      if (reachable.length > 0) this.switchAccount(reachable[0].id);
    }

    this.notifyToolbar();
    const focused = this.getFocusedAccounts();
    const total = calculateAggregateUnread(focused);
    updateDockBadge(calculateAggregateBadge(focused), this.getFocusedArrivals());
    this.onUnreadChanged?.(focused, total);
    this.onAccountsChanged?.();
  }

  public getActiveAccountId(): string {
    return this.activeAccountId;
  }

  public getActiveAccount(): AccountConfig | undefined {
    return this.accounts.find((a) => a.id === this.activeAccountId);
  }

  public getActiveWebContentsView(): WebContentsView | undefined {
    return this.pool.view(this.activeAccountId);
  }

  public getWebContentsViewForAccount(accountId: string): WebContentsView | undefined {
    return this.pool.view(accountId);
  }

  public getMainWindow(): BaseWindow {
    return this.mainWindow;
  }

  /**
   * Names the account a cold-launch link asked for, before `initialize()`.
   *
   * Called from `createMainWindow` before the first view exists. `initialize()`
   * resolves it, so an id that is no longer configured falls through to the last
   * active account.
   */
  public setInitialAccountId(accountId: string | undefined): void {
    this.requestedInitialAccountId = accountId;
  }

  /**
   * The account the first view should be built for.
   *
   * A cold-launch link wins, because it names what the user asked to see. Without
   * one the last active account is restored, which is what a normal relaunch should
   * do. The account list is authoritative, so a request naming a removed account
   * falls through to the first account.
   */
  private resolveInitialAccountId(requestedFromLink?: string): { id: string; source: string } {
    if (requestedFromLink) {
      const linked = this.accounts.find((a) => a.id === requestedFromLink);
      if (linked) return { id: linked.id, source: 'launch link' };
      log.warn(
        `Cold launch named account ${requestedFromLink}, which is not configured; falling back`,
      );
    }

    const remembered = this.accounts.find((a) => a.id === loadSettings().lastActiveAccountId);
    if (remembered) return { id: remembered.id, source: 'last active' };

    return { id: this.accounts[0]?.id ?? '', source: 'first account' };
  }

  /**
   * Records the account on screen so a plain relaunch returns to it.
   *
   * Called on the way out rather than on every switch, so an ordinary member switch
   * costs no settings write and boot still sees what a normal quit left behind.
   */
  public persistActiveAccount(): void {
    if (!this.activeAccountId) return;
    if (loadSettings().lastActiveAccountId === this.activeAccountId) return;
    saveSetting('lastActiveAccountId', this.activeAccountId);
  }

  public initialize(): void {
    const initial = this.resolveInitialAccountId(this.requestedInitialAccountId);
    this.activeAccountId = initial.id;
    log.info(
      `Initializing with ${this.accounts.length} account(s), active=${this.activeAccountId} ` +
        `(requested=${this.requestedInitialAccountId ?? 'none'}, source=${initial.source})`,
    );
    attachNativeToolbar(this.mainWindow);

    // Configure every account's partition, not only the ones that get a view.
    //
    // This is load-bearing for background notifications. The mailbox poller fetches
    // the feed through session.fromPartition() from the main process, so an
    // account that is never opened still needs its clean User-Agent and header
    // sanitisation installed — otherwise Google sees an Electron client on the
    // feed request. Before views became lazy this happened as a side effect of
    // createAccountView running for every account at startup.
    pruneOrphanPartitions(this.accounts.map((a) => a.partition));
    for (const account of this.accounts) {
      configureGoogleSession(account.partition);
    }

    // Clean up any legacy persisted category banner dismissals so that prompts
    // operate per-session instead of permanently hiding.
    const settings = loadSettings();
    if (settings.dismissedApiPrompts?.some((p) => p.endsWith('_category_banner'))) {
      saveSetting(
        'dismissedApiPrompts',
        settings.dismissedApiPrompts.filter((p) => !p.endsWith('_category_banner')),
      );
    }

    // Only the active account gets a view. The rest are created on first
    // switch — see ensureAccountView.
    this.switchAccount(this.activeAccountId);

    // No drag WebContentsView: the NSToolbar attached above sits over the
    // titlebar strip in the native view hierarchy and receives those mouse
    // events itself, so a -webkit-app-region:drag view underneath never saw
    // them (Electron #43320). AppKit drags the window from the toolbar's empty
    // space for free. Re-adding one costs a whole sandboxed renderer (~79MB).

    // 4. Update layouts on window resize
    this.mainWindow.on('resize', () => {
      this.updateLayout();
    });

    // A hidden window (tray-only mode) means nothing on screen is worth a
    // renderer, so the active account starts ageing out too. Showing the window
    // again cancels that and resumes it.
    this.mainWindow.on('hide', () => this.handleWindowHidden());
    this.mainWindow.on('show', () => {
      this.pool.handleWindowShown();
      // Deferred, because the tray shows the window *before* asking for a
      // specific account (see tray.showAccount / tray.showThread). Restoring
      // synchronously here would resurrect and reload the outgoing account
      // moments before it is switched away from again. By the microtask the
      // caller's own switchAccount has already run, so this only has to cover
      // the case where nobody asked for anything.
      queueMicrotask(() => {
        if (!this.pool.isWindowVisible()) return;
        if (this.isAccountLoaded(this.activeAccountId)) return;
        this.switchAccount(this.activeAccountId);
      });
    });

    this.updateLayout();

    // Re-inject styles on theme change instead of full page reload
    if (this.themeManager) {
      this.themeManager.onThemeChanged = () => {
        for (const [, view] of this.pool.entries()) {
          if (viewIsAlive(view)) {
            this.injectEarlyCss(view).catch(() => {});
            this.injectAllSubframes(view);
          }
        }
        // Update window background when transparency is off
        const settings = loadSettings();
        if (!settings.transparentBackground) {
          this.mainWindow.setBackgroundColor(
            getGoogleSurfaceColor(Boolean(this.themeManager?.isDark())),
          );
        }
      };
    }
  }

  private buildSubframeCss(): string {
    if (this.themeManager?.isDark()) {
      return getSubframeDarkModeCss();
    } else {
      return getSubframeLightModeCss();
    }
  }

  private async injectSubframeCss(frame: WebFrameMain): Promise<void> {
    if (frame.isDestroyed()) return;
    const css = this.buildSubframeCss();
    const code = `(()=>{try{let s=document.getElementById('magimail-subframe-styles');if(!s){s=document.createElement('style');s.id='magimail-subframe-styles';(document.head||document.documentElement).appendChild(s);}s.textContent=${JSON.stringify(css)};}catch(e){}})()`;
    try {
      await frame.executeJavaScript(code);
    } catch {
      // Ignore if frame is navigating or destroyed
    }
  }

  private injectAllSubframes(view: WebContentsView): void {
    const root = view.webContents.mainFrame;
    if (!root) return;
    const injectRecursively = (frame: WebFrameMain) => {
      if (!frame || frame.isDestroyed()) return;
      for (const child of frame.frames || []) {
        this.injectSubframeCss(child).catch(() => {});
        injectRecursively(child);
      }
    };
    injectRecursively(root);
  }

  private buildFullCss(): string {
    // --css-override replaces the composed stylesheet outright, so what lands
    // on the page is exactly what the file says and nothing is quietly merged
    // in behind it. See css-override.ts.
    const override = getCssOverride();
    if (override !== null) return override;
    const settings = loadSettings();
    const parts = [getGmailCustomCss()];
    if (this.themeManager?.isDark()) {
      parts.push(getGmailDarkModeCss());
    } else {
      parts.push(getGmailLightModeCss());
    }
    if (settings.hidePromotionAds) parts.push(getHideAdsCss());
    if (settings.hideSidebar) parts.push(getHideSidebarCss());
    return parts.join('\n');
  }

  private async injectEarlyCss(view: WebContentsView): Promise<void> {
    // Remove previous early CSS if it exists
    const oldKey = this.earlyCssKeys.get(view);
    if (oldKey) {
      view.webContents.removeInsertedCSS(oldKey).catch(() => {});
    }
    // Logged here rather than at the four call sites, which all discard it.
    // This failing is the most visible defect the app has -- light Gmail in
    // dark mode, or the sidebar and ads back -- and it produced no line.
    try {
      const key = await view.webContents.insertCSS(this.buildFullCss(), { cssOrigin: 'user' });
      this.earlyCssKeys.set(view, key);
    } catch (err) {
      log.error('Could not inject the early CSS; the page will render unstyled:', err);
    }
  }

  private createAccountView(account: AccountConfig): WebContentsView {
    configureGoogleSession(account.partition);

    const view = new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        partition: account.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: true,
        // `backgroundThrottling` stays at its default. Disabling it stops
        // Electron's hidden-view patch from reaching `DelegatedFrameHost::WasShown`,
        // so a view shown after a spell with nothing attached can produce no frame.
        // The mailbox-change hints a detached view used to keep warm only ever
        // accelerated the badge for the mailbox on screen, and the mailbox poller,
        // which owns the count outright, keeps running against the partition session
        // regardless of whether a renderer exists.
      },
    });
    view.setBackgroundColor('#00000000');

    // Records the page's own `/sync/` request headers for the direct triage write.
    // Registered before the first load, so the first `/sync/` the page makes is captured.
    observeGmailSyncState(view.webContents.session, account.partition);

    // Inject full CSS at navigation commit — before first paint.
    view.webContents.on('did-navigate', (_event, url) => {
      log.info(`Account ${account.id} navigated to:`, redactUrl(url));
      this.injectEarlyCss(view).catch(() => {});
    });

    // Style, show, and track Gmail-opened compose pop-outs
    view.webContents.on('did-create-window', (newWin) => {
      newWin.once('ready-to-show', () => {
        app.focus({ steal: true });
        newWin.show();
        newWin.focus();
        newWin.webContents.focus();
      });
      const settings = loadSettings();
      newWin.webContents.on('dom-ready', () => {
        injectGmailStyles(newWin.webContents, {
          darkMode: this.themeManager?.isDark() ?? false,
          hideAds: settings.hidePromotionAds,
          hideSidebar: settings.hideSidebar,
        });
      });
      // External links open in system browser
      newWin.webContents.setWindowOpenHandler(({ url: childUrl }) => {
        if (
          childUrl.startsWith('https://mail.google.com') ||
          childUrl.startsWith('https://accounts.google.com')
        ) {
          return { action: 'allow' };
        }
        shell.openExternal(childUrl);
        return { action: 'deny' };
      });

      // Resolve any pending compose popout promise
      if (this.pendingComposeResolve) {
        this.pendingComposeResolve(newWin);
        this.pendingComposeResolve = null;
      }
    });

    // Inject subframe styles whenever a child frame finishes loading
    view.webContents.on(
      'did-frame-finish-load',
      (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        if (!isMainFrame) {
          const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
          if (frame) {
            this.injectSubframeCss(frame).catch(() => {});
          }
        }
      },
    );

    // Intercept window opens
    view.webContents.setWindowOpenHandler(({ url }) => {
      // Compose windows — Gmail uses /popout for Cmd+click compose,
      // and view=cm for window.open compose. Match both.
      if (url.includes('view=cm') || url.includes('/popout')) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: createComposeWindowOptions({
            preloadPath: this.preloadPath,
            partitionName: account.partition,
          }),
        };
      }

      // Thread pop-out (Gmail thread URL opened via Shift+click)
      if (
        url.startsWith('https://mail.google.com/mail/') &&
        !url.includes('view=cm') &&
        (url.includes('#inbox/') ||
          url.includes('#thread/') ||
          url.includes('#sent/') ||
          url.includes('#all/'))
      ) {
        openDetachedThreadWindow(this.preloadPath, account.partition, url, this.themeManager);
        return { action: 'deny' };
      }

      // Authentic Gmail print view (user clicked print inside Gmail's own UI)
      if (url.includes('view=pt')) {
        if (!process.env.MAGIMAIL_E2E) {
          this.printUrl(url).catch(() => {});
        }
        return { action: 'deny' };
      }

      // Gmail print view, popups, and other internal windows
      if (url.startsWith('https://mail.google.com') || url === 'about:blank') {
        return { action: 'allow' };
      }

      const isGoogleAuth =
        url.startsWith('https://accounts.google.com') ||
        url.startsWith('https://myaccount.google.com') ||
        url.startsWith('https://workspace.google.com');

      if (isGoogleAuth) {
        view.webContents.loadURL(url);
        return { action: 'deny' };
      }

      log.info(`Account ${account.id} opening in the browser:`, redactUrl(url));
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // Intercept in-app navigation
    view.webContents.on('will-navigate', (event, url) => {
      const isGoogleAuthOrMail =
        url.startsWith('https://mail.google.com') ||
        url.startsWith('https://accounts.google.com') ||
        url.startsWith('https://myaccount.google.com') ||
        url.startsWith('https://workspace.google.com');

      if (!isGoogleAuthOrMail) {
        event.preventDefault();
        log.info(`Account ${account.id} navigating out to the browser:`, redactUrl(url));
        shell.openExternal(url);
      }
    });

    view.webContents.on('did-start-loading', () => {
      const url = view.webContents.getURL();
      if (account.id === this.activeAccountId && url && !url.includes('mail.google.com')) {
        this.clearBannerTimer();
        this.hideCategoryBanner();
      }
    });

    // Detect first successful Gmail sign-in (navigated to authenticated inbox)
    view.webContents.on('did-navigate', (_event, url) => {
      if (account.id === this.activeAccountId && (!url || !url.includes('mail.google.com'))) {
        this.clearBannerTimer();
        this.hideCategoryBanner();
      }
      if (!url.startsWith('data:')) {
        this.failedOfflineUrls.delete(account.id);
      }
      if (url.startsWith('https://mail.google.com/mail/') && !this.signInDetected.has(account.id)) {
        this.signInDetected.add(account.id);
        this.setAccountAuthRequired(account.id, false);
        this.onGmailSignIn?.(account.id);
      }
      if (account.id === this.activeAccountId) {
        this.updateToolbarActionState();
        this.onHistoryChanged?.();
      }
    });

    view.webContents.on('did-stop-loading', () => {
      if (account.id === this.activeAccountId) {
        this.syncCategoryBannerForActiveAccount();
      }
    });

    view.webContents.on('did-navigate-in-page', (_event, url) => {
      if (account.id === this.activeAccountId) {
        this.updateToolbarActionState(url);
        this.onHistoryChanged?.();
      }
    });

    // Handle offline / network load failures on main frame
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || errorCode === -3) return; // -3 is ERR_ABORTED

        if (isNetworkLoadFailure(errorCode)) {
          log.warn(
            `Account ${account.id} is offline: ${errorCode} ${errorDescription} at`,
            redactUrl(validatedURL),
          );
          this.failedOfflineUrls.set(account.id, validatedURL);
          this.renderOfflineError(view, validatedURL);
          return;
        }

        // Anything else leaves the pane on whatever it was showing, with no
        // offline page to explain it. The code is the whole diagnosis.
        log.error(
          `Account ${account.id} failed to load: ${errorCode} ${errorDescription} at`,
          redactUrl(validatedURL),
        );
      },
    );

    return view;
  }

  /** The window's `hide`, and a window built hidden, which fires no event. */
  public handleWindowHidden(): void {
    this.pool.handleWindowHidden();
  }

  /** Apply a new inactivity threshold from Settings. */
  public setSuspendDelayMinutes(minutes: number): void {
    this.pool.setSuspendDelayMinutes(minutes);
  }

  /** Tear down every account view that isn't needed right now. Used on quit. */
  public suspendAllAccounts(): void {
    // The banner and the mail-action queue are one per window rather than one per view, so
    // they are released here, once, whether or not any account view is still open.
    this.clearBannerTimer();
    if (this.categoryBannerView) {
      // The banner's view is a child of a window that may already be gone, by the same
      // route as an account view: suspend timers outlive the window that armed them.
      if (
        !this.windowIsGone() &&
        this.mainWindow.contentView.children.includes(this.categoryBannerView)
      ) {
        this.mainWindow.contentView.removeChildView(this.categoryBannerView);
        log.info(`Detached category banner on suspend all (${this.pool.attachedSummary()})`);
      }
      if (viewIsAlive(this.categoryBannerView)) {
        this.categoryBannerView.webContents.close();
      }
      this.categoryBannerView = null;
      this.isCategoryBannerVisible = false;
    }
    if (this.mailActionTimer) {
      clearInterval(this.mailActionTimer);
      this.mailActionTimer = null;
    }
    this.mailActionQueue.clear();

    this.pool.suspendAllAccounts();
  }

  /** Whether the window the pool attaches to is gone, taking its contentView with it. */
  private windowIsGone(): boolean {
    if (typeof this.mainWindow.isDestroyed !== 'function') return false;
    return this.mainWindow.isDestroyed();
  }

  /** Whether an account currently has a live renderer. */
  public isAccountLoaded(accountId: string): boolean {
    return this.pool.isAccountLoaded(accountId);
  }

  public switchAccount(accountId: string): void {
    const targetAccount = this.accounts.find((a) => a.id === accountId);
    if (!targetAccount) return;

    log.info(`Switching active account to ${accountId}`);
    this.activeAccountId = accountId;
    const activeView = this.pool.attachOnly(accountId);

    this.clearBannerTimer();
    this.hideCategoryBanner();
    this.syncCategoryBannerForActiveAccount();
    this.updateLayout();

    // Load URL only after view is attached and has full window bounds. A
    // resumed account returns to where it was rather than to the inbox.
    if (activeView) {
      const firstLoad = this.pool.firstLoadUrl(accountId, GMAIL_LOGIN_URL);
      if (firstLoad) activeView.webContents.loadURL(firstLoad);
    }

    this.notifyToolbar();
    this.updateToolbarActionState();
    const effective = this.getEffectiveUnreadForAccount(accountId);
    this.accounts = updateAccountUnread(this.accounts, accountId, effective);
    const focused = this.getFocusedAccounts();
    const total = calculateAggregateUnread(focused);
    updateDockBadge(calculateAggregateBadge(focused), this.getFocusedArrivals());
    this.onUnreadChanged?.(focused, total);
    this.onMissingCategoriesChanged?.(accountId, this.getMissingCategoriesForAccount(accountId));
    // Rebuilds the application menu, which marks the account being viewed.
    // Switching was the one account change that notified nothing.
    this.onAccountsChanged?.();
    this.onAccountSwitched?.(accountId);
  }

  /**
   * Selects an account and points its view at a URL.
   *
   * The two halves belong together: `switchAccount` picks the account and wakes its
   * renderer, loading `resumeUrl`, and the load then gives it the destination. The
   * tray's search field is the one caller; sequencing the two itself would leave a
   * search on a suspended account reading an active view that is not there.
   */
  public openInAccount(accountId: string | undefined, url: string): void {
    const target = accountId || this.activeAccountId;
    this.switchAccount(target);

    const view = this.pool.view(target);
    if (!viewIsAlive(view)) {
      log.warn(`No view for ${target}; navigation to ${redactUrl(url)} dropped`);
      return;
    }
    void Promise.resolve(view.webContents.loadURL(url)).catch((err) => {
      log.warn(`Navigation to ${redactUrl(url)} on ${target} failed:`, err);
    });
  }

  public switchToIndex(index: number): void {
    const visible = this.getVisibleAccounts();
    if (index >= 0 && index < visible.length) {
      // ⌘1-9 follows the switcher, which lists every account, so the index is
      // stable whatever the filter does. A disabled account still refuses the
      // switch, matching its greyed-out segment and menu item.
      if (this.isDisabledByFocus(visible[index].id)) return;
      this.switchAccount(visible[index].id);
    }
  }

  public setWindowFocused(focused: boolean): void {
    this.isWindowFocused = focused;
  }

  public getMissingCategoriesForAccount(accountId: string): NotificationCategory[] {
    return this.missingCategoriesByAccount.get(accountId) || [];
  }

  /**
   * Presses Gmail's toolbar refresh control in any open WebContentsView.
   */
  public async pressGmailRefreshControl(accountId?: string): Promise<void> {
    if (accountId) {
      const view = this.getWebContentsViewForAccount(accountId);
      await pressRefreshControl(view?.webContents);
    } else {
      for (const account of this.accounts) {
        const view = this.getWebContentsViewForAccount(account.id);
        await pressRefreshControl(view?.webContents);
      }
    }
  }

  public getEffectiveUnreadForAccount(accountId: string): number {
    const source = this.mailboxSources.get(accountId);
    if (source) {
      const counts = source.getUnreadCounts();
      if (counts.hasState) return counts.total;
    }
    const acc = this.accounts.find((a) => a.id === accountId);
    return acc?.unreadCount ?? 0;
  }

  private cacheDerivedCategories: Map<string, Set<NotificationCategory>> = new Map();

  /**
   * Merge, never replace: a round that fetched two sub-feeds must not erase what
   * the other three were last known to be.
   */
  private recordCategoryCounts(
    accountId: string,
    counts: Map<NotificationCategory, number>,
    isFromCache = false,
  ): void {
    let known = this.lastKnownCategoryCounts.get(accountId);
    if (!known) {
      known = new Map();
      this.lastKnownCategoryCounts.set(accountId, known);
    }
    let cacheDerived = this.cacheDerivedCategories.get(accountId);
    if (!cacheDerived) {
      cacheDerived = new Set();
      this.cacheDerivedCategories.set(accountId, cacheDerived);
    }
    for (const [cat, count] of counts) {
      if (isFromCache) {
        cacheDerived.add(cat);
        known.set(cat, count);
      } else {
        // If this category was already determined from the local inbox cache,
        // do not allow the Atom sub-feed (which includes archived mail) to clobber it.
        if (!cacheDerived.has(cat)) {
          known.set(cat, count);
        }
      }
    }
  }

  /**
   * Updates category counts derived from the local cache.
   *
   * Unlike the DOM sidebar links and Atom sub-feeds which include archived mail,
   * the local cache query specifically filters for items that are both unread (^u)
   * and in the inbox (^i) and not trashed (^k).
   */
  public handleCacheCategoryCounts(
    accountId: string,
    categoryCounts: Map<NotificationCategory, number>,
  ): void {
    this.recordCategoryCounts(accountId, categoryCounts, true);

    // The ledger owns the count once it has any state. This method is now only a
    // category-count fallback for a cache read that has not reached the ledger yet.
    const source = this.mailboxSources.get(accountId);
    if (source?.getUnreadCounts().hasState) return;

    const notifSettings = loadSettings().notifications || {};
    let cacheTotal = 0;
    const allCategories: NotificationCategory[] = [
      'primary',
      'updates',
      'promotions',
      'social',
      'forums',
    ];
    for (const cat of allCategories) {
      if (notifSettings[cat] === 'off') continue;
      cacheTotal += categoryCounts.get(cat) ?? 0;
    }

    // Only a changed total is worth announcing. The caller that reads the cache
    // for the widget snapshot also calls this, and `onUnreadChanged` runs that
    // same snapshot read, so announcing an unchanged total would re-enter it for
    // as long as a renderer is awake.
    let effectiveUnread = this.getEffectiveUnreadForAccount(accountId);
    if (source && source.getUnreadCounts().rawFullCount === null && cacheTotal > 0) {
      effectiveUnread = cacheTotal;
    }
    const currentUnread = this.accounts.find((a) => a.id === accountId)?.unreadCount ?? 0;
    if (effectiveUnread === currentUnread) return;

    this.accounts = updateAccountUnread(this.accounts, accountId, effectiveUnread);
    const focused = this.getFocusedAccounts();
    const total = calculateAggregateUnread(focused);
    updateDockBadge(calculateAggregateBadge(focused), this.getFocusedArrivals());
    this.notifyToolbar();
    this.onUnreadChanged?.(focused, total);
  }

  public handleDomUnreadUpdate(accountId: string, report: DomUnreadReport): void {
    this.domReports.set(accountId, report);

    if (report.hasCategoriesSection) {
      this.accountsWithCategoriesObserved.add(accountId);
    }

    const absent = this.getAbsentCategoriesForAccount(accountId);
    this.onAbsentCategoriesChanged?.(accountId, absent);

    this.checkMissingCategories(accountId, report);
  }

  /**
   * Categories that are enabled in user notification settings but currently absent
   * from the DOM report (e.g. folded under Categories, collapsed under More, or missing),
   * or absent from the local cache.
   * These categories require Atom feed sub-polling to ensure accurate unread totals.
   */
  public getAbsentCategoriesForAccount(accountId: string): NotificationCategory[] {
    const settings = loadSettings();
    const notifSettings = settings.notifications || {};
    const domReport = this.domReports.get(accountId);
    const present = new Set(domReport?.presentCategories || []);
    const lookupCategories: NotificationCategory[] = ['updates', 'promotions', 'social', 'forums'];
    const absent: NotificationCategory[] = [];
    const hasCache = this.offlineCacheAvailableByAccount.get(accountId);

    for (const cat of lookupCategories) {
      if (notifSettings[cat] && notifSettings[cat] !== 'off') {
        // When the local cache is absent, non-primary categories require sub-polling.
        // When the local cache is available, it provides all category unreads so sub-polling is not needed.
        if (hasCache !== true && (hasCache === false || !present.has(cat))) {
          absent.push(cat);
        }
      }
    }
    return absent;
  }

  public handleOfflineCacheStatus(accountId: string, hasCache: boolean): void {
    const prev = this.offlineCacheAvailableByAccount.get(accountId);
    if (prev === hasCache) return;
    this.offlineCacheAvailableByAccount.set(accountId, hasCache);

    const absent = this.getAbsentCategoriesForAccount(accountId);
    this.onAbsentCategoriesChanged?.(accountId, absent);

    if (accountId === this.activeAccountId) {
      if (hasCache) {
        this.clearBannerTimer();
        this.hideCategoryBanner();
      } else {
        this.syncCategoryBannerForActiveAccount();
      }
    }
  }

  public isOfflineCacheAvailable(accountId: string): boolean | undefined {
    return this.offlineCacheAvailableByAccount.get(accountId);
  }

  private checkMissingCategories(accountId: string, report: DomUnreadReport): void {
    // If Gmail's DOM report explicitly indicates the mailbox/sidebar is not yet loaded,
    // do not evaluate missing categories yet to prevent premature flashes.
    if (report.isLoaded === false) {
      return;
    }

    // Category counts are sourced directly from Gmail's local cache,
    // which accurately computes true unread inbox items (^i + ^u) without needing
    // categories pinned or unfolded in the sidebar. We no longer prompt the user with
    // a configuration banner to force categories into the sidebar.
    const missing: NotificationCategory[] = [];

    this.missingCategoriesByAccount.set(accountId, missing);

    if (accountId === this.activeAccountId) {
      this.syncCategoryBannerForActiveAccount();
    }

    // Send missing categories to the active view to display/hide banner
    const view = this.pool.view(accountId);
    if (viewIsAlive(view)) {
      view.webContents.send(IPC_CHANNELS.UPDATE_MISSING_CATEGORIES, missing);
    }

    this.onMissingCategoriesChanged?.(accountId, missing);
  }

  public isCategoryBannerDismissed(accountId: string): boolean {
    return this.dismissedBannersThisSession.has(accountId);
  }

  public dismissCategoryBanner(accountId: string): void {
    this.dismissedBannersThisSession.add(accountId);
    this.hideCategoryBanner();
  }

  public isCategoryBannerShowing(): boolean {
    return this.isCategoryBannerVisible;
  }

  public clearBannerTimer(): void {
    if (this.bannerShowTimer) {
      clearTimeout(this.bannerShowTimer);
      this.bannerShowTimer = null;
    }
  }

  public syncCategoryBannerForActiveAccount(immediate = false): void {
    const hasCache = this.offlineCacheAvailableByAccount.get(this.activeAccountId);
    const missing = this.missingCategoriesByAccount.get(this.activeAccountId) || [];
    const isDismissed = this.isCategoryBannerDismissed(this.activeAccountId);

    const shouldShowOffline = hasCache === false && !isDismissed;
    const shouldShowCategories = missing.length > 0 && !isDismissed;

    if ((!shouldShowOffline && !shouldShowCategories) || isDismissed) {
      this.clearBannerTimer();
      this.hideCategoryBanner();
      return;
    }

    if (this.isCategoryBannerVisible) {
      if (shouldShowOffline) {
        this.showOfflineBanner(this.activeAccountId);
      } else {
        this.showCategoryBanner(this.activeAccountId, missing);
      }
      return;
    }

    if (immediate || this.bannerSettleDelayMs <= 0) {
      if (shouldShowOffline) {
        this.showOfflineBanner(this.activeAccountId);
      } else {
        this.showCategoryBanner(this.activeAccountId, missing);
      }
      return;
    }

    if (this.bannerShowTimer) {
      return;
    }

    const targetAccountId = this.activeAccountId;
    this.bannerShowTimer = setTimeout(() => {
      this.bannerShowTimer = null;
      if (targetAccountId !== this.activeAccountId) return;

      const targetHasCache = this.offlineCacheAvailableByAccount.get(targetAccountId);
      const targetMissing = this.missingCategoriesByAccount.get(targetAccountId) || [];
      const targetDismissed = this.isCategoryBannerDismissed(targetAccountId);

      if ((targetHasCache !== false && targetMissing.length === 0) || targetDismissed) {
        return;
      }

      const activeView = this.pool.view(targetAccountId);
      if (activeView && viewIsAlive(activeView) && activeView.webContents.isLoading()) {
        activeView.webContents.once('did-stop-loading', () => {
          this.syncCategoryBannerForActiveAccount();
        });
        return;
      }

      if (targetHasCache === false) {
        this.showOfflineBanner(targetAccountId);
      } else {
        this.showCategoryBanner(targetAccountId, targetMissing);
      }
    }, this.bannerSettleDelayMs);
  }

  public recalculateMissingCategories(): void {
    for (const [accountId, report] of this.domReports.entries()) {
      this.checkMissingCategories(accountId, report);
    }
  }

  private showOfflineBanner(_accountId?: string): void {
    this.currentBannerType = 'offlineMail';
    const banner = this.getOrCreateCategoryBannerView();
    const html = this.getCategoryBannerHtml(
      uiString('banner.offlineMail.message'),
      uiString('banner.offlineMail.openSettings'),
    );
    banner.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => {});

    if (!this.mainWindow.contentView.children.includes(banner)) {
      this.mainWindow.contentView.addChildView(banner);
      log.info(`Attached offline mail banner (${this.pool.attachedSummary()})`);
    }
    this.isCategoryBannerVisible = true;
    this.updateLayout();
  }

  private showCategoryBanner(accountId: string, missing: NotificationCategory[]): void {
    this.currentBannerType = 'categories';
    const banner = this.getOrCreateCategoryBannerView();
    const titles = missing.map((c) => c.charAt(0).toUpperCase() + c.slice(1));
    // The list separates by the system language's own rules, so no "and"
    // connector is written here.
    const formattedCategories = new Intl.ListFormat(undefined, {
      style: 'long',
      type: 'conjunction',
    }).format(titles);

    const html = this.getCategoryBannerHtml(
      uiString('banner.categories.message', {
        categories: `<strong>${formattedCategories}</strong>`,
      }),
      uiString('banner.categories.openSettings'),
    );
    banner.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch(() => {});

    if (!this.mainWindow.contentView.children.includes(banner)) {
      this.mainWindow.contentView.addChildView(banner);
      log.info(`Attached category banner (${this.pool.attachedSummary()})`);
    }
    this.isCategoryBannerVisible = true;
    this.updateLayout();
  }

  private hideCategoryBanner(): void {
    this.clearBannerTimer();
    if (
      this.categoryBannerView &&
      this.mainWindow.contentView.children.includes(this.categoryBannerView)
    ) {
      this.mainWindow.contentView.removeChildView(this.categoryBannerView);
      log.info(`Detached category banner (${this.pool.attachedSummary()})`);
    }
    if (this.isCategoryBannerVisible) {
      this.isCategoryBannerVisible = false;
      this.updateLayout();
    }
  }

  private openGmailOfflineSettings(): void {
    const activeView = this.pool.view(this.activeAccountId);
    if (!viewIsAlive(activeView)) return;
    const currentUrl = activeView.webContents.getURL();
    if (currentUrl && currentUrl.includes('mail.google.com')) {
      activeView.webContents
        .executeJavaScript("window.location.hash = '#settings/offline'; true;")
        .catch(() => {
          let settingsUrl = 'https://mail.google.com/mail/u/0/#settings/offline';
          const uMatch = currentUrl.match(/mail\.google\.com\/mail\/u\/(\d+)/);
          if (uMatch) {
            settingsUrl = `https://mail.google.com/mail/u/${uMatch[1]}/#settings/offline`;
          }
          activeView.webContents.loadURL(settingsUrl).catch(() => {});
        });
    } else {
      activeView.webContents
        .loadURL('https://mail.google.com/mail/u/0/#settings/offline')
        .catch(() => {});
    }
  }

  private openGmailLabelSettings(): void {
    const activeView = this.pool.view(this.activeAccountId);
    if (!viewIsAlive(activeView)) return;
    const currentUrl = activeView.webContents.getURL();
    if (currentUrl && currentUrl.includes('mail.google.com')) {
      activeView.webContents
        .executeJavaScript("window.location.hash = '#settings/labels'; true;")
        .catch(() => {
          let settingsUrl = 'https://mail.google.com/mail/u/0/#settings/labels';
          const uMatch = currentUrl.match(/mail\.google\.com\/mail\/u\/(\d+)/);
          if (uMatch) {
            settingsUrl = `https://mail.google.com/mail/u/${uMatch[1]}/#settings/labels`;
          }
          activeView.webContents.loadURL(settingsUrl).catch(() => {});
        });
    } else {
      activeView.webContents
        .loadURL('https://mail.google.com/mail/u/0/#settings/labels')
        .catch(() => {});
    }
  }

  private getOrCreateCategoryBannerView(): WebContentsView {
    if (!this.categoryBannerView) {
      this.categoryBannerView = new WebContentsView();
      const handleNavigation = (url: string) => {
        if (url.includes('settings')) {
          if (this.currentBannerType === 'offlineMail') {
            this.openGmailOfflineSettings();
          } else {
            this.openGmailLabelSettings();
          }
        } else if (url.includes('dismiss')) {
          this.dismissCategoryBanner(this.activeAccountId);
        }
      };
      this.categoryBannerView.webContents.on('will-navigate', (event, url) => {
        event.preventDefault();
        handleNavigation(url);
      });
      this.categoryBannerView.webContents.setWindowOpenHandler(({ url }) => {
        handleNavigation(url);
        return { action: 'deny' };
      });
    }
    return this.categoryBannerView;
  }

  private getCategoryBannerHtml(
    message: string,
    openSettingsLabel: string = uiString('banner.categories.openSettings'),
  ): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root {
    --bg: #f5f5f7;
    --border: rgba(0, 0, 0, 0.12);
    --text: #1d1d1f;
    --text-muted: #6e6e73;
    --btn-bg: #ffffff;
    --btn-border: rgba(0, 0, 0, 0.16);
    --btn-hover: #f0f0f2;
    --btn-text: #1d1d1f;
    --close-hover: rgba(0, 0, 0, 0.08);
    --close-color: #86868b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #28282a;
      --border: rgba(255, 255, 255, 0.1);
      --text: #f5f5f7;
      --text-muted: #a1a1a6;
      --btn-bg: rgba(255, 255, 255, 0.14);
      --btn-border: rgba(255, 255, 255, 0.15);
      --btn-hover: rgba(255, 255, 255, 0.22);
      --btn-text: #ffffff;
      --close-hover: rgba(255, 255, 255, 0.12);
      --close-color: #98989d;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  body {
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif;
    font-size: 12px;
    line-height: 1.4;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 14px;
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
    color: var(--text);
  }
  .content {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .message {
    color: var(--text-muted);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .message strong {
    color: var(--text);
    font-weight: 600;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
    margin-left: 12px;
  }
  .settings-btn {
    display: inline-flex;
    align-items: center;
    background: var(--btn-bg);
    border: 1px solid var(--btn-border);
    color: var(--btn-text);
    padding: 2px 9px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    text-decoration: none;
    box-shadow: 0 1px 1px rgba(0, 0, 0, 0.04);
    transition: background 0.12s ease;
  }
  .settings-btn:hover {
    background: var(--btn-hover);
  }
  .dismiss-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 4px;
    color: var(--close-color);
    cursor: pointer;
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .dismiss-btn:hover {
    background: var(--close-hover);
    color: var(--text);
  }
</style>
</head>
<body>
  <div class="content">
    <span class="icon">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="#eab308">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
    </span>
    <span class="message">${message}</span>
  </div>
  <div class="actions">
    <a href="magimail-banner://settings" class="settings-btn">${openSettingsLabel}</a>
    <a href="magimail-banner://dismiss" class="dismiss-btn" title="${uiString('banner.categories.dismiss')}">✕</a>
  </div>
  <script>
    document.querySelector('.settings-btn').addEventListener('click', function(e) {
      e.preventDefault();
      window.location.href = 'magimail-banner://settings';
    });
    document.querySelector('.dismiss-btn').addEventListener('click', function(e) {
      e.preventDefault();
      window.location.href = 'magimail-banner://dismiss';
    });
  </script>
</body>
</html>`;
  }

  /**
   * Records what a poll learned about a mailbox, without touching its unread count.
   *
   * The count comes from the account's `MailboxSource` and nowhere else. A source's
   * base count may lag behind a local triage, so applying it here would undo the
   * preemptive change during the read-path grace.
   */
  public handlePollMetadata(
    accountId: string,
    categoryCounts?: Map<NotificationCategory, number>,
    newArrivalCount?: number,
    arrivalsIncomplete?: boolean,
  ): void {
    if (categoryCounts) {
      this.recordCategoryCounts(accountId, categoryCounts);
    }
    if (newArrivalCount !== undefined) {
      this.arrivalsByAccount.set(accountId, newArrivalCount);
    }
    if (arrivalsIncomplete !== undefined) {
      if (arrivalsIncomplete) this.arrivalsIncompleteByAccount.add(accountId);
      else this.arrivalsIncompleteByAccount.delete(accountId);
    }
  }

  /**
   * Applies an externally reported count directly.
   *
   * Kept for callers with no `MailboxSource`; the poll path uses
   * `handlePollMetadata` and lets the source's ledger own the number.
   */
  public handleExternalUnreadUpdate(
    accountId: string,
    totalUnread: number,
    categoryCounts?: Map<NotificationCategory, number>,
    newArrivalCount?: number,
    arrivalsIncomplete?: boolean,
  ): void {
    this.handlePollMetadata(accountId, categoryCounts, newArrivalCount, arrivalsIncomplete);

    const source = this.mailboxSources.get(accountId);
    let unreadToApply = this.getEffectiveUnreadForAccount(accountId);
    if (categoryCounts && this.lastKnownCategoryCounts.has(accountId)) {
      const known = this.lastKnownCategoryCounts.get(accountId)!;
      const notifSettings = loadSettings().notifications || {};
      let blended = 0;
      for (const [cat, count] of known) {
        if (notifSettings[cat] === 'off') continue;
        blended += count;
      }
      unreadToApply = blended;
    } else if (source && source.getUnreadCounts().rawFullCount === null) {
      unreadToApply = totalUnread;
    }
    log.info(
      `(Accounts) handleExternalUnreadUpdate for ${accountId}: totalUnread=${totalUnread}, applied=${unreadToApply}`,
    );

    this.accounts = updateAccountUnread(this.accounts, accountId, unreadToApply);
    // The badge and the menu bar count what the filter includes; the switcher
    // still shows every account's own count, dimmed.
    const focused = this.getFocusedAccounts();
    const total = calculateAggregateUnread(focused);
    updateDockBadge(calculateAggregateBadge(focused), this.getFocusedArrivals());
    this.notifyToolbar();
    this.onUnreadChanged?.(focused, total);
  }

  public setAccountAuthRequired(accountId: string, needsAuth: boolean): void {
    const acc = this.accounts.find((a) => a.id === accountId);
    if (!acc || Boolean(acc.needsAuth) === needsAuth) return;

    this.accounts = updateAccountAuth(this.accounts, accountId, needsAuth);
    saveAccounts(this.accounts);
    this.notifyToolbar();
    this.onAccountsChanged?.();
    const focused = this.getFocusedAccounts();
    const total = calculateAggregateUnread(focused);
    this.onUnreadChanged?.(focused, total);
  }

  public handleNetworkStatusChange(isOnline: boolean): void {
    if (!isOnline) return;
    const failedUrl = this.failedOfflineUrls.get(this.activeAccountId);
    const activeView = this.getActiveWebContentsView();
    if (failedUrl && viewIsAlive(activeView)) {
      this.failedOfflineUrls.delete(this.activeAccountId);
      log.info(`Back online; reloading ${this.activeAccountId}`);
      activeView.webContents
        .loadURL(failedUrl)
        .catch((err) => log.error('The reload after coming back online failed:', err));
    }
  }

  private renderOfflineError(view: WebContentsView, retryUrl: string): void {
    view.webContents
      .loadURL(
        offlinePageDataUrl(
          {
            appName: 'Magimail',
            serviceName: 'Gmail',
            retryUrl,
            isDark: this.themeManager?.isDark() ?? false,
          },
          uiString,
        ),
      )
      .catch(() => {});
  }

  /** Resolves the account that owns a given webContents id, if any. */
  public getAccountIdForWebContentsId(webContentsId: number): string | undefined {
    for (const [accountId, view] of this.pool.entries()) {
      if (viewIsAlive(view) && view.webContents.id === webContentsId) {
        return accountId;
      }
    }
    return undefined;
  }

  public updateLayout(): void {
    const [width, height] = this.mainWindow.getContentSize();
    const bannerHeight = this.isCategoryBannerVisible ? CATEGORY_BANNER_HEIGHT : 0;

    if (this.isCategoryBannerVisible && this.categoryBannerView) {
      this.categoryBannerView.setBounds({
        x: 0,
        y: TOOLBAR_HEIGHT,
        width,
        height: bannerHeight,
      });
    }

    const activeView = this.pool.view(this.activeAccountId);
    if (activeView) {
      activeView.setBounds({
        x: 0,
        y: TOOLBAR_HEIGHT + bannerHeight,
        width,
        height: Math.max(0, height - TOOLBAR_HEIGHT - bannerHeight),
      });
    }
  }

  public notifyToolbar(): void {
    updateNativeToolbarAccounts(
      this.getVisibleAccounts().map((a) => ({
        ...a,
        excludedByFocus: this.isExcludedByFocus(a.id),
        disabledByFocus: this.isDisabledByFocus(a.id),
      })),
      this.activeAccountId,
    );
  }

  /**
   * Reloads the active account view.
   *
   * Rebuilds the view through the pool rather than calling `webContents.reload()`,
   * so an account whose WebContents or compositor has stopped presenting recovers
   * cleanly when the user hits Cmd+R or chooses Reload from the menu.
   */
  public reloadActiveView(): void {
    if (!this.activeAccountId) return;
    this.rebuildAccountView(this.activeAccountId);
  }

  /**
   * Rebuilds an account view from scratch through the pool.
   *
   * Closes the dead WebContents, creates a fresh replacement view,
   * updates layout, and navigates it back to the route the user was on.
   */
  public rebuildAccountView(accountId: string): WebContentsView | undefined {
    log.info(`Rebuilding account view for ${accountId}`);
    const view = this.pool.rebuildView(accountId, {
      fallbackUrl: GMAIL_LOGIN_URL,
      onLayout: () => this.updateLayout(),
    });
    if (view) {
      this.onAccountsChanged?.();
    }
    return view;
  }

  /**
   * Reload the account on screen after the machine wakes, waking it if it went to sleep.
   *
   * A window hidden over the sleep has had its renderer released, which is what left
   * most resume wakes reloading nothing. The plain `reloadActiveView` stays a no-op in
   * that state on purpose: a settings change that just needs styles re-injected should
   * not spend a Gmail load on an account nobody is looking at.
   */
  public reloadActiveViewOnResume(): void {
    void this.reloadActiveAccountOnResume();
  }

  private async reloadActiveAccountOnResume(): Promise<void> {
    const accountId = this.activeAccountId;
    // The reload replaces the resume URL, so there is nothing to wait on.
    const woken = await this.wakeAccountForAction(accountId, false);
    if (!woken) return;
    const { view, release } = woken;
    try {
      view.webContents.reload();
    } finally {
      release();
    }
  }

  public reapplyStyles(): void {
    for (const [, view] of this.pool.entries()) {
      if (viewIsAlive(view)) {
        this.injectEarlyCss(view).catch(() => {});
        this.injectAllSubframes(view);
      }
    }
  }

  /**
   * Clears one account's cookies and site storage, then returns its view to the
   * sign-in page. Other accounts' partitions are untouched.
   *
   * Named by id rather than "active" because the Settings → Accounts button acts on
   * the account selected in its list, which is not necessarily the one on screen.
   */
  public async resetSession(accountId: string): Promise<void> {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;
    const { session } = await import('electron');
    const ses = session.fromPartition(account.partition);
    // Everything above this line in the log describes an account whose cookies
    // have since been wiped. Without the line, the reader cannot tell.
    log.warn(`Resetting the session for ${account.id} (${account.partition})`);
    await ses.clearStorageData();
    const view = this.pool.view(account.id);
    if (viewIsAlive(view)) {
      view.webContents.loadURL(GMAIL_LOGIN_URL);
    }
  }

  public focusSearchInActiveView(): void {
    void this.focusSearchInActiveAccount();
  }

  private async focusSearchInActiveAccount(): Promise<void> {
    const accountId = this.activeAccountId;
    const woken = await this.wakeAccountForAction(accountId);
    if (!woken) return;
    const { view, release } = woken;
    try {
      await view.webContents.executeJavaScript(`
        ${DOM_DRIVE_PREAMBLE}
        (() => {
          const found = findAction(document, ${JSON.stringify(domAction('search'))});
          if (found.el) {
            found.el.focus();
            found.el.select();
          }
        })();
      `);
    } catch (err) {
      log.warn(`Search focus failed on ${accountId}:`, err);
    } finally {
      release();
    }
  }

  public async triggerMailAction(
    action:
      | 'archive'
      | 'trash'
      | 'markRead'
      | 'markUnread'
      | 'compose'
      | 'reply'
      | 'replyAll'
      | 'forward',
    targetAccountId?: string,
  ): Promise<boolean> {
    const accountId = targetAccountId || this.activeAccountId;

    // One lookup drives all of these. The map resolves each action through the
    // band it belongs to: a strong hook where Gmail left one (`act`, `gh`,
    // `name`), a localised label where it left only the control's own name. An
    // action resolves through exactly one band, never a fallback chain, so a
    // hook miss is a miss rather than a guess at a label. Reply, Reply to all
    // and Forward are labels; the rest are hooks. See docs/shared/dom-labels.md.
    const actionEntry = DOM_ACTION_MAP.actions[action];
    if (!actionEntry) return false;

    const woken = await this.wakeAccountForAction(accountId);
    if (!woken) return false;
    const { view, release } = woken;

    try {
      const clicked = await view.webContents.executeJavaScript(`
        ${DOM_DRIVE_PREAMBLE}
        (() => {
          const found = findAction(document, ${JSON.stringify(actionEntry)});
          if (!found.el) return false;
          found.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          found.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          found.el.click();
          return true;
        })();
      `);
      if (!clicked) {
        // A view that was created for a suspended account had no URL, and a
        // control can be absent for other reasons too; the warn is the only
        // trace a dropped action leaves.
        log.warn(`No ${action} control in ${accountId}'s view; nothing was clicked`);
      }
      return clicked;
    } catch (err) {
      log.warn(`Could not drive ${action} on ${accountId}:`, err);
      return false;
    } finally {
      release();
    }
  }

  private waitForViewReady(view: WebContentsView, timeoutMs = 10000): Promise<void> {
    const wc = view.webContents;
    if (wc.isDestroyed() || !wc.isLoading()) return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        wc.off('did-stop-loading', finish);
        wc.off('destroyed', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      wc.once('did-stop-loading', finish);
      wc.once('destroyed', finish);
    });
  }

  private async waitForGmail(view: WebContentsView, timeoutMs = 15000): Promise<boolean> {
    const wc = view.webContents;
    if (wc.isDestroyed()) return false;

    if (!wc.getURL().includes('mail.google.com')) {
      const loaded = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
        const finish = () => {
          clearTimeout(timer);
          wc.off('did-stop-loading', finish);
          wc.off('destroyed', finish);
          resolve(!wc.isDestroyed());
        };
        wc.once('did-stop-loading', finish);
        wc.once('destroyed', finish);
      });
      if (!loaded) return false;
    }

    // The wait runs in the page, so readiness is seen as it happens rather than sampled
    // from here every 100 ms. Gmail still navigates under it — an account resuming
    // redirects once it has a session — which tears down the context and rejects the
    // call, so an exception re-enters with whatever budget is left instead of giving up.
    const deadline = Date.now() + timeoutMs;
    while (!wc.isDestroyed()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      try {
        return await wc.executeJavaScript(`
          ${DOM_DRIVE_PREAMBLE}
          (async () => Boolean(await waitUntil(
            () => resolveOrdered(['[role="main"]', '[gh="cm"]']) !== null || location.hash.length > 0,
            { timeoutMs: ${remaining}, label: 'gmail-ready' },
          )))()
        `);
      } catch {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 100);
          timer.unref?.();
        });
      }
    }
    return false;
  }

  /**
   * Whether the view holds work a background route change would interrupt.
   *
   * Covers open compose windows (docked or pop-out dialogs), inline replies,
   * active text inputs, settings, and modal alerts.
   */
  private async isBusyEditing(view: WebContentsView): Promise<boolean> {
    try {
      const busy = await view.webContents.executeJavaScript(`
        (() => {
          if (location.hash.startsWith('#settings')) return true;
          if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return true;
          const active = document.activeElement;
          if (active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable ||
            active.getAttribute('role') === 'textbox'
          )) {
            return true;
          }
          const textboxes = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
          for (const box of textboxes) {
            if ((box.textContent || '').trim().length > 0) return true;
          }
          return false;
        })();
      `);
      return Boolean(busy);
    } catch {
      return false;
    }
  }

  private queueMailAction(item: QueuedMailAction): void {
    const key = `${item.accountId}:${item.messageId}:${item.action}`;
    // Keeps the first timestamp, so a press retried every five seconds still expires
    // fifteen minutes after it was made rather than never.
    const existing = this.mailActionQueue.get(key);
    this.mailActionQueue.set(key, { ...item, queuedAt: existing?.queuedAt ?? item.queuedAt });
    if (existing) return;
    if (this.mailActionTimer) return;
    this.mailActionTimer = setInterval(() => void this.drainMailActionQueue(), 5000);
    this.mailActionTimer.unref?.();
  }

  private async drainMailActionQueue(): Promise<void> {
    const now = Date.now();
    for (const [key, item] of [...this.mailActionQueue.entries()]) {
      if (now - item.queuedAt > 15 * 60 * 1000) {
        this.mailActionQueue.delete(key);
        log.warn(`Expired queued ${item.action} on ${item.accountId}; editor remained busy`);
        continue;
      }

      const view = this.pool.view(item.accountId);
      if (viewIsAlive(view)) {
        if (await this.isBusyEditing(view)) continue;
      }

      this.mailActionQueue.delete(key);
      void this.performThreadAction(item.accountId, item.messageId, item.action);
    }

    if (this.mailActionQueue.size === 0 && this.mailActionTimer) {
      clearInterval(this.mailActionTimer);
      this.mailActionTimer = null;
    }
  }

  /** The renderer an action needs, waking a suspended account behind it. */
  private wakeAccountForAction(
    accountId: string,
    waitForLoad = true,
  ): Promise<{ view: WebContentsView; release: () => void } | undefined> {
    return this.pool.wakeForAction(accountId, {
      loginUrl: GMAIL_LOGIN_URL,
      attachForAction: (view) => this.sizeForBackgroundAction(view, accountId),
      waitForLoad: waitForLoad ? (view) => this.waitForGmail(view) : undefined,
      waitForReady: (view) => this.waitForViewReady(view),
    });
  }

  /**
   * Act on one named thread, wherever the request came from.
   *
   * The only way to act on a thread that is not the selection on screen.
   * `triggerMailAction` drives Gmail's own toolbar in the active view, so it
   * hits whatever happens to be selected there; this routes the account's view
   * to the thread first, acts, and routes back. A notification button, a
   * `magimail://thread/` URL and the menu bar popover all arrive here.
   *
   * Returns whether the action landed, which `routeAcrossWindow` reads to decide whether the
   * window it built for the action actually served it.
   */
  public async performThreadAction(
    accountId: string,
    messageId: string,
    action: ThreadAction,
  ): Promise<boolean> {
    if (!this.accounts.some((a) => a.id === accountId)) return false;

    // Triage fired at a banner or a popover row leaves no other trace: the window does
    // not move and the account on screen does not change, so without this the only
    // evidence any of it ran is the mail itself changing.
    log.info(`Thread action ${action} on ${accountId}`);

    // Only opening asks to look at something. The rest is triage fired at a
    // banner or a popover row, so it neither raises the window nor changes
    // which account is on screen. The window is raised before the view is woken:
    // waking loads Gmail again, and leaving the user on a blank window until it
    // finishes is worse than showing the account it is about to switch to.
    if (action === 'open') {
      this.mainWindow.show();
      this.mainWindow.focus();

      const woken = await this.wakeAccountForAction(accountId);
      if (!woken) return false;
      const { view, release } = woken;

      this.switchAccount(accountId);
      try {
        if (await this.isShowingThread(view, messageId)) return true;
        const routed = await this.routeToThread(view, messageId);
        if (!routed) {
          log.info(`Dropped open on ${accountId}: the view would not leave what it is showing`);
          await this.restorePreviousRoute(view, messageId);
          return false;
        }
        return true;
      } finally {
        release();
      }
    }

    // Triage does not wake the account: the mailbox source owns the action.
    const source = this.mailboxSources.get(accountId);
    if (source) {
      return source.triageThread(messageId, action as TriageAction);
    }
    return false;
  }

  /**
   * Give a view a real viewport for the length of a background action.
   *
   * Returns the undo. The account on screen is left alone: it is already sized, and
   * moving it would move what the user is looking at.
   *
   * Sizing is not enough on its own. `switchAccount` detaches every view but the
   * active one, and a view with no parent has nothing to lay out in, so it has to be
   * attached as well. It is inserted at the bottom of the stack, given the same rect
   * as the account on screen and kept hidden while it is there: it still gets the
   * full-width layout Gmail needs to render a thread toolbar, but one account's mail
   * is never drawn across another's, not even while the page above it is still
   * transparent before its first paint. Placing it beside the window instead does not
   * work; bounds outside the parent are clipped back to nothing.
   *
   * The view stays hidden while the action runs, so the page throttles as a
   * background tab does; the waits in `packages/core/src/dom.ts` lean on a
   * MutationObserver and a 50 ms poll, which is the part that slows down.
   */
  private sizeForBackgroundAction(view: WebContentsView, accountId: string): () => void {
    // The account on screen is normally already attached and sized, so there is
    // nothing to do. It is not attached while the window is hidden, though: the
    // active account is suspended then too, and a woken one needs the same
    // treatment as any other background view.
    if (accountId === this.activeAccountId && this.mainWindow.contentView.children.includes(view)) {
      return () => {};
    }

    const [width, height] = this.mainWindow.getContentSize();
    const bannerHeight = this.isCategoryBannerVisible ? CATEGORY_BANNER_HEIGHT : 0;
    const wasAttached = this.mainWindow.contentView.children.includes(view);
    if (!wasAttached) {
      if (typeof view.setVisible === 'function') {
        view.setVisible(false);
      }
      this.mainWindow.contentView.addChildView(view, 0);
      log.info(
        `Attached view for background action on account ${accountId} at index 0 (${this.pool.attachedSummary()})`,
      );
    }
    view.setBounds({
      x: 0,
      y: TOOLBAR_HEIGHT + bannerHeight,
      width,
      height: Math.max(0, height - TOOLBAR_HEIGHT - bannerHeight),
    });

    return () => {
      if (!viewIsAlive(view)) return;
      // The user may have switched to this account while the action ran, in which
      // case it is now the one on screen and the normal layout owns it.
      if (accountId === this.activeAccountId) {
        if (typeof view.setVisible === 'function') {
          view.setVisible(true);
        }
        this.updateLayout();
        return;
      }
      if (!wasAttached && this.mainWindow.contentView.children.includes(view)) {
        this.mainWindow.contentView.removeChildView(view);
        log.info(
          `Detached view for background action on account ${accountId} (${this.pool.attachedSummary()})`,
        );
      }
      if (typeof view.setVisible === 'function') {
        view.setVisible(true);
      }
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    };
  }

  /**
   * Route the view to a thread and wait until Gmail has actually rendered it.
   *
   * Navigates by assigning `location.hash` inside the page rather than
   * `loadURL`. Gmail's live URL carries a query (`?pli=1`) that the thread URL
   * does not, so `loadURL` differs from the current document by more than its
   * fragment and reloads the page outright — which tears down any open compose.
   * A hash assignment is always a same-document route, and Gmail merges the two
   * states itself: the hash becomes `#inbox/<thread>?compose=<draft>` and a
   * docked compose or inline reply survives untouched.
   */
  /**
   * Whether the view is already showing a thread, by whichever id names it.
   *
   * The URL is not enough on the path this matters most. A notification carries the
   * Atom feed's legacy hex id, Gmail resolves it and rewrites the hash to its own
   * canonical `#inbox/FMfcgz…` form, and from then on the id we were handed appears
   * nowhere in the URL. The open thread still carries it in the DOM, as
   * `data-legacy-thread-id` and `data-legacy-message-id`, so ask there as well.
   *
   * The DOM alone is not enough either, and answering yes wrongly is the expensive
   * way round: a message listed in the inbox carries those same attributes on its
   * row, so a view sitting on `#inbox` looks like it is showing every thread in it.
   * The caller would then skip routing and hunt for a thread toolbar on a list. So
   * the DOM only counts when the view is on a thread route to begin with.
   */
  private async isShowingThread(view: WebContentsView, id: string): Promise<boolean> {
    const wc = view.webContents;
    if (wc.isDestroyed()) return false;
    const url = wc.getURL();
    if (url.includes(id)) return true;
    if (!this.isThreadUrl(url)) return false;

    try {
      return await wc.executeJavaScript(`
        Boolean(document.querySelector(
          '[data-legacy-thread-id=' + ${JSON.stringify(JSON.stringify(id))} + '],' +
          '[data-legacy-message-id=' + ${JSON.stringify(JSON.stringify(id))} + ']'
        ))
      `);
    } catch {
      return false;
    }
  }

  private async routeToThread(view: WebContentsView, threadId: string): Promise<boolean> {
    const wc = view.webContents;
    // The caller has already established the view is not showing this thread, which is
    // what decides whether to route at all; asking again is a second round trip into
    // the page for an answer that cannot have changed.

    const beforeTitle = wc.getTitle();

    try {
      const routed = await wc.executeJavaScript(`
        (() => {
          // Guard against routing out from under an active editor, compose or settings
          if (location.hash.startsWith('#settings')) return false;
          if (document.querySelector('[role="dialog"], [role="alertdialog"]') !== null) return false;
          const active = document.activeElement;
          if (active && (
            active.tagName === 'INPUT' ||
            active.tagName === 'TEXTAREA' ||
            active.isContentEditable ||
            active.getAttribute('role') === 'textbox'
          )) {
            return false;
          }
          const textboxes = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
          for (const box of textboxes) {
            if ((box.textContent || '').trim().length > 0) return false;
          }

          window.__magimailPrevHash = location.hash;
          location.hash = '#inbox/' + ${JSON.stringify(threadId)};
          return true;
        })();
      `);
      if (routed === false) return false;
    } catch {
      return false;
    }

    // Arrival is the title moving off what came before while the URL names a thread,
    // the same pair the old fifty-attempt loop watched; only the sampling is gone,
    // because the title is now waited for in the page rather than read every 100 ms.
    //
    // The thread id is deliberately not part of the test. Gmail rewrites the hash to
    // its own canonical id as the thread renders, so a notification's legacy id stops
    // matching at exactly the moment the route succeeds; `restorePreviousRoute` works
    // around the same rewrite. `isThreadUrl` asks the question that survives it.
    //
    // The title is the baseline for each pass, so a render that lands somewhere that
    // is not a thread — Gmail bouncing back to the list — waits for the next move
    // instead of returning, and cannot spin: every pass needs a fresh title.
    const deadline = Date.now() + 5000;
    let baseline = beforeTitle;
    while (!wc.isDestroyed()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;

      const moved = await wc
        .executeJavaScript(
          `
        ${DOM_DRIVE_PREAMBLE}
        (async () => {
          const there = await waitUntil(() => document.title !== ${JSON.stringify(baseline)}, {
            timeoutMs: ${remaining},
            label: 'thread-route',
          });
          return there ? document.title : false;
        })()
      `,
        )
        .catch(() => false);

      if (moved === false || wc.isDestroyed()) return false;
      if (this.isThreadUrl(wc.getURL())) {
        // Settling is best-effort: a route that arrives and then keeps redrawing is
        // still a route that arrived, and failing it would report a thread the caller
        // had in fact reached as one it never got to.
        await wc
          .executeJavaScript(
            `
          ${DOM_DRIVE_PREAMBLE}
          waitUntil(() => true, { quietMs: 250, timeoutMs: 5000, label: 'thread-settle' })
        `,
          )
          .catch(() => {});
        return true;
      }
      baseline = typeof moved === 'string' ? moved : baseline;
    }
    return false;
  }

  /**
   * Put the view back where it was before a notification action routed it.
   *
   * Only restores if the view is still showing the target thread. If the user
   * navigated elsewhere or switched accounts while the action ran, do not
   * overwrite their active route.
   */
  private async restorePreviousRoute(
    view: WebContentsView,
    targetThreadId?: string,
  ): Promise<void> {
    const target = JSON.stringify(targetThreadId ?? null);
    try {
      await view.webContents.executeJavaScript(`
        (() => {
          const prev = window.__magimailPrevHash;
          delete window.__magimailPrevHash;

          // Whether the view is still on the thread the action routed it to. The hash
          // alone cannot say: Gmail rewrites it to its own canonical id, so a
          // notification's legacy id stops matching the moment the thread renders, and
          // comparing hashes reads every restore as "the user moved" and abandons it.
          // The rendered thread still carries the id we were given.
          const target = ${target};
          if (target) {
            const onTarget =
              location.hash.includes(target) ||
              document.querySelector(
                '[data-legacy-thread-id=' + JSON.stringify(target) + '],' +
                '[data-legacy-message-id=' + JSON.stringify(target) + ']'
              ) !== null;
            // The user navigated away while the action ran; leave them where they are.
            if (!onTarget) return;
          }

          if (prev && prev !== location.hash) location.hash = prev;
        })();
      `);
    } catch {
      // The view may have been suspended out from under us.
    }
  }

  public triggerArchiveInActiveView(): void {
    this.triggerMailAction('archive');
  }

  public triggerDeleteInActiveView(): void {
    this.triggerMailAction('trash');
  }

  public toggleReadState(): void {
    void this.toggleReadStateInActiveAccount();
  }

  private async toggleReadStateInActiveAccount(): Promise<void> {
    const accountId = this.activeAccountId;
    const woken = await this.wakeAccountForAction(accountId);
    if (!woken) return;
    const { view, release } = woken;
    try {
      const clicked = await view.webContents.executeJavaScript(`
        ${DOM_DRIVE_PREAMBLE}
        (() => {
          // Gmail renders both controls and lays out only the one the
          // selection's state calls for, so whichever is on screen *is* the
          // toggle: mark as unread for something read, mark as read for
          // something unread. A thread only ever offers mark as unread.
          const actions = ${JSON.stringify(READ_TOGGLE_ACTIONS.map((name) => domAction(name)))};
          let el = null;
          for (const action of actions) {
            el = findAction(document, action).el;
            if (el) break;
          }
          if (!el) return false;
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          el.click();
          return true;
        })();
      `);
      if (!clicked) {
        log.warn(`No read control in ${accountId}'s view; nothing was clicked`);
      }
    } catch (err) {
      log.warn(`Read toggle failed on ${accountId}:`, err);
    } finally {
      release();
    }
  }

  public sendInputToActiveView(char: string): void {
    if (char === 'c') {
      this.triggerMailAction('compose');
    } else if (char === 'r') {
      this.triggerMailAction('reply');
    } else if (char === 'a') {
      this.triggerMailAction('replyAll');
    } else if (char === 'f') {
      this.triggerMailAction('forward');
    } else {
      const activeView = this.pool.view(this.activeAccountId);
      if (viewIsAlive(activeView)) {
        activeView.webContents.sendInputEvent({ type: 'char', keyCode: char });
      }
    }
  }

  /**
   * Opens a Gmail compose pop-out window. If composeParams is provided
   * (e.g. 'to=x&su=y'), opens via window.open with a pre-filled URL.
   * Otherwise Cmd+clicks the Compose button for a blank compose.
   * Both paths reuse Gmail's loaded session.
   */
  public async triggerComposePopout(
    fieldsOrParams?: ComposeFields | string,
  ): Promise<import('electron').BrowserWindow | null> {
    let fields: ComposeFields | undefined;
    if (typeof fieldsOrParams === 'string') {
      const search = new URLSearchParams(fieldsOrParams);
      fields = {
        to: search.get('to') || undefined,
        cc: search.get('cc') || undefined,
        bcc: search.get('bcc') || undefined,
        subject: search.get('su') || search.get('subject') || undefined,
        body: search.get('body') || undefined,
      };
    } else if (fieldsOrParams && typeof fieldsOrParams === 'object') {
      fields = fieldsOrParams;
    }

    const woken = await this.wakeAccountForAction(this.activeAccountId);
    if (!woken) return null;
    const { view, release } = woken;

    const promise = new Promise<import('electron').BrowserWindow | null>((resolve) => {
      this.pendingComposeResolve = resolve;
      setTimeout(() => {
        if (this.pendingComposeResolve === resolve) {
          composeLog.info('Timeout — compose window did not appear');
          this.pendingComposeResolve = null;
          resolve(null);
        }
      }, 15000);
    });

    // Cmd+click Gmail's Compose button to open native pop-out (/popout)
    // with fallback to window.open if Compose button is not yet rendered
    view.webContents
      .executeJavaScript(
        `
      ${DOM_DRIVE_PREAMBLE}
      (() => {
        const found = findAction(document, ${JSON.stringify(domAction('compose'))});
        if (found.el) {
          found.el.dispatchEvent(new MouseEvent('click', {
            bubbles: true, cancelable: true, metaKey: true
          }));
          return true;
        }
        window.open('https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1', '_blank', 'width=720,height=770');
        return false;
      })();
    `,
      )
      .catch(() => {});

    try {
      const composeWin = await promise;
      if (composeWin && fields) {
        await populateComposeFields(composeWin, fields);
      }

      return composeWin;
    } finally {
      release();
    }
  }

  public addAccount(name: string, color: string): AccountConfig {
    const account = createNewAccount(name, color);
    log.info(`Adding account ${account.id}`);
    this.accounts.push(account);
    saveAccounts(this.accounts);
    // No view yet — a brand new account gets one when it is first switched to.
    // Its partition still needs configuring for the poller that main.ts starts
    // straight away; that poller reports 401 until the user signs in.
    configureGoogleSession(account.partition);
    this.mailboxSources.set(account.id, this.createMailboxSource(account));
    this.notifyToolbar();
    this.onAccountsChanged?.();
    return account;
  }

  public removeAccount(accountId: string): boolean {
    if (this.accounts.length <= 1) return false;
    const index = this.accounts.findIndex((a) => a.id === accountId);
    if (index === -1) return false;

    log.info(`Removing account ${accountId}`);
    const source = this.mailboxSources.get(accountId);
    if (source) {
      source.forget();
      this.mailboxSources.delete(accountId);
    }
    // A filter that still names the account would leave the switcher and the badge
    // leaning on an id nothing can reach. `focus-filter.json` itself is left alone: the
    // App Intents extension owns it, and an id it names that no longer exists is ignored.
    if (this.focusFilter?.activeAccountIds.includes(accountId)) {
      const remaining = this.focusFilter.activeAccountIds.filter((id) => id !== accountId);
      this.focusFilter =
        remaining.length > 0 ? { ...this.focusFilter, activeAccountIds: remaining } : null;
    }
    this.pool.removeView(accountId);
    const removedPartition = this.accounts[index].partition;

    this.accounts.splice(index, 1);
    saveAccounts(this.accounts);
    this.arrivalsByAccount.delete(accountId);
    this.arrivalsIncompleteByAccount.delete(accountId);
    // Everything else keyed by the account goes with it. None of it is wiped by the
    // account being gone, so a stale entry stays in memory for the life of the process and,
    // for the queued action, is still drained against a view that no longer exists.
    this.signInDetected.delete(accountId);
    this.failedOfflineUrls.delete(accountId);
    this.dismissedBannersThisSession.delete(accountId);
    this.offlineCacheAvailableByAccount.delete(accountId);
    this.accountsWithCategoriesObserved.delete(accountId);
    this.domReports.delete(accountId);
    this.lastKnownCategoryCounts.delete(accountId);
    this.cacheDerivedCategories.delete(accountId);
    this.missingCategoriesByAccount.delete(accountId);
    for (const key of [...this.mailActionQueue.keys()]) {
      if (key.startsWith(`${accountId}:`)) this.mailActionQueue.delete(key);
    }
    // The account id is a timestamp, so the partition it used is never signed in to again:
    // its cookies are a Google session left on disk for the life of the install. Clearing
    // removes the credential now; the directory itself is swept on the next launch.
    const ses = session.fromPartition(removedPartition);
    void ses.clearStorageData().catch((err: unknown) => {
      log.warn(`Could not clear the session for the removed account ${accountId}:`, err);
    });
    void ses.clearCache().catch(() => {});

    if (this.activeAccountId === accountId) {
      this.switchAccount(this.accounts[0].id);
    }
    this.notifyToolbar();
    this.onAccountsChanged?.();
    return true;
  }

  public updateAccountConfig(
    accountId: string,
    updates: { name?: string; color?: string },
  ): boolean {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return false;
    if (updates.name !== undefined) account.name = updates.name;
    if (updates.color !== undefined) account.color = updates.color;
    saveAccounts(this.accounts);
    this.notifyToolbar();
    // A rename has to reach the Accounts menu as well as the toolbar.
    this.onAccountsChanged?.();
    return true;
  }

  public reorderAccounts(accountIds: string[]): void {
    const reordered = accountIds
      .map((id) => this.accounts.find((a) => a.id === id))
      .filter((a): a is AccountConfig => a !== undefined);
    if (reordered.length !== this.accounts.length) return;
    this.accounts = reordered;
    saveAccounts(this.accounts);
    this.notifyToolbar();
    this.onAccountsChanged?.();
  }

  // MARK: - Outbound Sharing & Authentic Print / PDF

  public isThreadUrl(url: string): boolean {
    try {
      const urlObj = new URL(url);

      // Direct query parameters indicating thread view or print view
      if (urlObj.searchParams.has('th') || urlObj.searchParams.has('permthid')) {
        return true;
      }
      const viewParam = urlObj.searchParams.get('view');
      if (viewParam === 'cv' || viewParam === 'pt') {
        return true;
      }

      const hash = urlObj.hash;
      if (!hash) return false;
      const cleanHash = hash.replace(/^#/, '').split('?')[0];

      // Thread permalinks: #thread-f:12345... or #thread-a:12345...
      if (/^thread-[fa]:[a-zA-Z0-9_-]+$/i.test(cleanHash)) {
        return true;
      }

      if (!cleanHash.includes('/')) return false;

      // Standard mailbox views: #inbox/<id>, #sent/<id>, #all/<id>, #starred/<id>, etc.
      // Exclude pagination (e.g. #inbox/p2)
      if (
        /^(?:inbox|all|sent|starred|snoozed|trash|spam|drafts|imp|chats|section_default)\/(?!p\d+$)[a-zA-Z0-9_-]{5,}$/i.test(
          cleanHash,
        )
      ) {
        return true;
      }

      // Categories: #category~<cat>/<id> or #category/<cat>/<id>
      // Exclude category root list (e.g. #category/social) and pagination (#category/social/p2)
      if (/^category[~/][^/]+\/(?!p\d+$)[a-zA-Z0-9_-]{5,}$/i.test(cleanHash)) {
        return true;
      }

      // Labels or search: #label/<nested>/<id> or #search/<query>/<id>
      const parts = cleanHash.split('/');
      const prefix = parts[0].toLowerCase();
      if (prefix === 'label' || prefix === 'search' || prefix === 'advanced-search') {
        const lastPart = parts[parts.length - 1];
        if (parts.length >= 3 && !/^p\d+$/i.test(lastPart)) {
          if (
            /^[0-9a-fA-F]{12,}$/i.test(lastPart) ||
            /^FMfcg/i.test(lastPart) ||
            lastPart.length >= 10
          ) {
            return true;
          }
        }
      }

      return false;
    } catch {
      return false;
    }
  }

  public async isThreadOpen(): Promise<boolean> {
    return this.isThreadOpenSync();
  }

  public isThreadOpenSync(url?: string): boolean {
    if (url) return this.isThreadUrl(url);
    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) return false;
    return this.isThreadUrl(view.webContents.getURL());
  }

  public updateToolbarActionState(target?: boolean | string): void {
    if (typeof target === 'boolean') {
      setThreadOnlyItemsEnabled(target);
      if (!target) setNativeToolbarShareUrl('');
      this.refreshReplyControls(target);
      this.onThreadStateChanged?.(target);
      return;
    }

    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) {
      setThreadOnlyItemsEnabled(false);
      setNativeToolbarShareUrl('');
      this.refreshReplyControls(false);
      this.onThreadStateChanged?.(false);
      return;
    }

    const currentUrl = typeof target === 'string' ? target : view.webContents.getURL();
    // If the target URL has no thread hash (e.g. from an HTTP navigation commit) but the
    // view has already moved to an authentic thread, prevent the stale event from disabling actions.
    const liveUrl = view.webContents.getURL();
    const effectiveUrl =
      !this.isThreadUrl(currentUrl) && this.isThreadUrl(liveUrl) ? liveUrl : currentUrl;
    const isThread = this.isThreadUrl(effectiveUrl);
    setThreadOnlyItemsEnabled(isThread);
    this.pushShareUrl(isThread ? effectiveUrl : '');
    this.refreshReplyControls(isThread);
    this.onThreadStateChanged?.(isThread);
  }

  /**
   * Enable each reply control according to whether the thread renders it.
   *
   * One DOM scan reports all three, and one write applies them, so the controls
   * cannot disagree with each other or with a scan still in flight. The scan
   * waits briefly because Gmail draws these a beat after the thread body; a
   * newer scan supersedes an older one, since the selection can move on while
   * one is waiting.
   */
  private refreshReplyControls(isThread: boolean): void {
    const generation = (this.replyControlScan += 1);

    if (!isThread) {
      setReplyControlsEnabled({ reply: false, replyAll: false, forward: false });
      return;
    }

    void this.scanReplyControls()
      .then((present) => {
        if (generation !== this.replyControlScan) return;
        setReplyControlsEnabled(present);
      })
      .catch(() => {
        setReplyControlsEnabled({ reply: false, replyAll: false, forward: false });
      });
  }

  /**
   * Which of Gmail's reply controls the open thread currently renders.
   *
   * Polls briefly rather than concluding from one look, because the controls
   * appear shortly after the thread body. It settles as soon as any of them is
   * found, so a thread that offers all three is not delayed by one that offers
   * none.
   */
  private async scanReplyControls(): Promise<Record<'reply' | 'replyAll' | 'forward', boolean>> {
    const absent = { reply: false, replyAll: false, forward: false };
    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) return absent;

    try {
      return await view.webContents.executeJavaScript(`
        ${DOM_DRIVE_PREAMBLE}
        (async () => {
          const actions = ${JSON.stringify(
            Object.fromEntries(REPLY_CONTROLS.map((id) => [id, domAction(id)])),
          )};

          const scan = () => {
            const found = {};
            for (const [id, action] of Object.entries(actions)) {
              found[id] = findAction(document, action).el !== null;
            }
            return found;
          };

          // The controls arrive after the thread body, so wait for any of them to
          // appear rather than polling a fixed twelve times and reading "none" off a
          // slow render.
          const found = await waitUntil(() => {
            const result = scan();
            return result.reply || result.replyAll || result.forward ? result : null;
          }, { quietMs: 0, timeoutMs: 10000, label: 'reply-controls' });
          return found || scan();
        })();
      `);
    } catch {
      return absent;
    }
  }

  /**
   * Keep the native share picker's link current.
   *
   * The picker reads its items synchronously, so the URL is pushed as the
   * selection changes rather than resolved on click. The live view URL goes
   * over immediately so the picker is never stale, then the canonical thread
   * permalink replaces it once `getThreadUrl` resolves — the same preference
   * order `shareActiveThreadLink` uses.
   */
  private pushShareUrl(url: string): void {
    setNativeToolbarShareUrl(url);
    if (!url) return;

    void this.getThreadUrl()
      .then((permalink) => {
        if (permalink) setNativeToolbarShareUrl(permalink);
      })
      .catch(() => {
        // Keep the view URL already pushed above.
      });
  }

  public async getThreadUrl(): Promise<string | null> {
    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) return null;

    const currentUrl = view.webContents.getURL();
    return this.isThreadUrl(currentUrl) ? currentUrl : null;
  }

  public async getThreadSubject(accountId?: string): Promise<string> {
    const view = this.pool.view(accountId || this.activeAccountId);
    if (!viewIsAlive(view)) return 'Email';

    try {
      const title = await view.webContents.executeJavaScript(`
        ${DOM_DRIVE_PREAMBLE}
        (() => {
          // Ordered, not comma-joined: document order would let the legacy fallback
          // win over the permanent id it is only a fallback for. The minified class
          // that used to be matched on is deliberately gone — the document title,
          // which carries the subject, remains below for a thread that renders
          // neither attribute.
          const subjectEl = resolveOrdered([
            'h2[data-thread-perm-id]',
            '[data-legacy-thread-id] h2',
          ]);
          if (subjectEl && subjectEl.textContent && subjectEl.textContent.trim()) {
            return subjectEl.textContent.trim();
          }
          const docTitle = document.title || '';
          const cleaned = docTitle
            .replace(/\\s*-\\s*[^\\s@]+@[^\\s@]+\\s*-\\s*Gmail$/i, '')
            .replace(/\\s*-\\s*Gmail$/i, '')
            .trim();
          return cleaned || 'Email';
        })()
      `);
      return title || 'Email';
    } catch {
      return 'Email';
    }
  }

  public showNoEmailSelectedDialog(): void {
    dialog.showMessageBox(this.mainWindow as unknown as BrowserWindow, {
      type: 'info',
      title: uiString('dialog.noEmailSelected.title'),
      message: uiString('dialog.noEmailSelected.message'),
      detail: uiString('dialog.noEmailSelected.detail'),
      buttons: [uiString('dialog.ok')],
    });
  }

  public async getAuthenticPrintUrl(accountId?: string): Promise<string | null> {
    const targetAccountId = accountId || this.activeAccountId;
    const view = this.pool.view(targetAccountId);
    if (!viewIsAlive(view)) return null;

    const currentUrl = view.webContents.getURL();
    if (!this.isThreadUrl(currentUrl)) return null;

    // Every account in Magimail runs in its own isolated persist: partition sandbox,
    // where its single authenticated session is always user index 0 (/u/0/).
    const uIndex = '0';

    // 1. Resolve authentic thread identifier from the live DOM (e.g. "Print all" link or perm ID)
    try {
      const domAffordance = await view.webContents.executeJavaScript(`
        (() => {
          // Check for "Print all" link or button in the thread DOM
          const printLinks = Array.from(
            document.querySelectorAll('a[href*="view=pt"], [data-href*="view=pt"]'),
          );
          for (const el of printLinks) {
            const href = el.getAttribute('href') || el.getAttribute('data-href') || '';
            if (href) {
              try {
                const parsed = new URL(href, window.location.origin);
                const permthid = parsed.searchParams.get('permthid');
                if (permthid) return { permthid };
                const th = parsed.searchParams.get('th');
                if (th) return { th };
                if (parsed.searchParams.get('view') === 'pt') {
                  return { rawUrl: parsed.href };
                }
              } catch {}
            }
          }

          // Check for thread perm ID attribute (e.g. h2[data-thread-perm-id])
          const permIdEl = document.querySelector('[data-thread-perm-id]');
          if (permIdEl) {
            const permId = permIdEl.getAttribute('data-thread-perm-id');
            if (permId && permId.trim()) return { permthid: permId.trim() };
          }

          // Check for legacy thread ID attribute (e.g. [data-legacy-thread-id])
          const legacyEl = document.querySelector('[data-legacy-thread-id]');
          if (legacyEl) {
            const legacyId = legacyEl.getAttribute('data-legacy-thread-id');
            if (legacyId && legacyId.trim()) return { th: legacyId.trim() };
          }

          return null;
        })()
      `);

      if (domAffordance) {
        if (domAffordance.permthid) {
          return `https://mail.google.com/mail/u/${uIndex}/?view=pt&search=all&permthid=${encodeURIComponent(domAffordance.permthid)}`;
        }
        if (domAffordance.th) {
          return `https://mail.google.com/mail/u/${uIndex}/?view=pt&search=all&th=${encodeURIComponent(domAffordance.th)}`;
        }
        if (domAffordance.rawUrl) {
          return domAffordance.rawUrl.replace(/\/u\/\d+\//, `/u/${uIndex}/`);
        }
      }
    } catch {
      // DOM execution may fail or be unavailable; fall back to URL analysis
    }

    // 2. Fall back to URL query parameters or hash if DOM inspection did not yield an identifier
    try {
      const urlObj = new URL(currentUrl);
      if (urlObj.searchParams.has('permthid')) {
        return `https://mail.google.com/mail/u/${uIndex}/?view=pt&search=all&permthid=${encodeURIComponent(urlObj.searchParams.get('permthid')!)}`;
      }
      if (urlObj.searchParams.has('th')) {
        return `https://mail.google.com/mail/u/${uIndex}/?view=pt&search=all&th=${encodeURIComponent(urlObj.searchParams.get('th')!)}`;
      }

      const hash = urlObj.hash;
      const cleanHash = hash.replace(/^#/, '').split('?')[0];

      // Thread permalink: #thread-f:12345 or #thread-a:12345
      if (/^thread-[fa]:[a-zA-Z0-9_-]+$/i.test(cleanHash)) {
        return `https://mail.google.com/mail/u/${uIndex}/?view=pt&search=all&permthid=${encodeURIComponent(cleanHash)}`;
      }

      // Legacy hex thread ID in route format: #inbox/1800000000000001, #all/1800000000000001
      // Only hex IDs (>=12 hex characters) can be used as th=. Modern FMfcgz... conversation IDs
      // require permthid from the DOM and will cause "conversation deleted" if passed to th=.
      const parts = cleanHash.split('/');
      const lastPart = parts[parts.length - 1];
      if (lastPart && /^[0-9a-fA-F]{12,}$/.test(lastPart)) {
        return `https://mail.google.com/mail/u/${uIndex}/?view=pt&search=all&th=${encodeURIComponent(lastPart)}`;
      }
    } catch {
      // Ignore
    }

    return null;
  }

  public async createPrintWindow(
    printUrl: string,
    accountId?: string,
  ): Promise<BrowserWindow | null> {
    const targetAccountId = accountId || this.activeAccountId;
    const account = this.accounts.find((a) => a.id === targetAccountId) || this.getActiveAccount();
    if (!account) return null;

    const printWin = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        preload: this.preloadPath,
        partition: account.partition,
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    try {
      await printWin.loadURL(printUrl);

      // Wait for page load and idle signal rather than a blind arbitrary timeout
      await printWin.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const onIdle = () => {
            if (window.requestIdleCallback) {
              window.requestIdleCallback(() => resolve(true), { timeout: 1000 });
            } else {
              setTimeout(() => resolve(true), 100);
            }
          };

          if (document.readyState === 'complete') {
            onIdle();
          } else {
            window.addEventListener('load', () => onIdle(), { once: true });
            setTimeout(() => resolve(true), 1500);
          }
        });
      `);

      // Validate that the print view landed on authentic thread content
      const loadedUrl = printWin.webContents.getURL();
      if (
        loadedUrl.includes('accounts.google.com') ||
        loadedUrl.includes('ServiceLogin') ||
        loadedUrl.includes('InteractiveLogin') ||
        loadedUrl.includes('signin')
      ) {
        printWin.destroy();
        return null;
      }

      const title =
        typeof printWin.webContents.getTitle === 'function' ? printWin.webContents.getTitle() : '';
      if (
        /conversation deleted|conversation has been deleted|sign in|google accounts|error/i.test(
          title,
        )
      ) {
        printWin.destroy();
        return null;
      }

      const isInvalid = await printWin.webContents.executeJavaScript(`
        (() => {
          const title = document.title || '';
          if (/conversation deleted|conversation has been deleted/i.test(title)) {
            return true;
          }
          const text = document.body ? (document.body.innerText || document.body.textContent || '') : '';
          if (/the conversation (?:requested )?has been deleted/i.test(text)) {
            return true;
          }
          if (document.querySelector('form[action*="ServiceLogin"], input[type="password"]')) {
            return true;
          }
          return false;
        })()
      `);

      if (isInvalid) {
        printWin.destroy();
        return null;
      }

      return printWin;
    } catch {
      printWin.destroy();
      return null;
    }
  }

  public async printUrl(url: string, accountId?: string): Promise<boolean> {
    const printWin = await this.createPrintWindow(url, accountId);
    if (printWin) {
      if (process.env.MAGIMAIL_E2E) {
        printWin.destroy();
        return true;
      }
      printWin.webContents.print({ silent: false, printBackground: true }, () => {
        printWin.destroy();
      });
      return true;
    }
    return false;
  }

  public goBack(): boolean {
    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) return false;

    const currentUrl = view.webContents.getURL();
    if (this.isThreadUrl(currentUrl)) {
      const backAction = domAction('back');
      log.info(`Exiting thread view ${currentUrl} via Back action`);
      void view.webContents
        .executeJavaScript(
          `
        ${DOM_DRIVE_PREAMBLE}
        (() => {
          const found = findAction(document, ${JSON.stringify(backAction)});
          if (found && found.el) {
            // Gmail returns focus to the thread's row as the list comes back, and a
            // focused element is scrolled into view. Left alone that drags the list
            // away from where it was when the thread opened; scrolling the list back
            // afterwards loses the same place a second time. Focus still moves, it
            // just must not scroll, and the override lasts only for the transition.
            const originalFocus = HTMLElement.prototype.focus;
            HTMLElement.prototype.focus = function (options) {
              return originalFocus.call(this, Object.assign({}, options, { preventScroll: true }));
            };
            try {
              found.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
              found.el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              found.el.click();
              found.el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true }));
              found.el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, cancelable: true }));
              if (typeof found.el.blur === 'function') found.el.blur();
            } finally {
              setTimeout(() => {
                HTMLElement.prototype.focus = originalFocus;
              }, 500);
            }
            return true;
          }
          return false;
        })()
      `,
        )
        .then((clicked) => {
          if (!clicked && viewIsAlive(view) && view.webContents.canGoBack()) {
            view.webContents.goBack();
          }
        });
      return true;
    }

    if (view.webContents.canGoBack()) {
      view.webContents.goBack();
      return true;
    }

    return false;
  }

  public goForward(): boolean {
    const view = this.getActiveWebContentsView();
    if (viewIsAlive(view) && view.webContents.canGoForward()) {
      view.webContents.goForward();
      return true;
    }
    return false;
  }

  public canGoBack(): boolean {
    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) return false;
    if (view.webContents.canGoBack()) return true;
    return this.isThreadUrl(view.webContents.getURL());
  }

  public canGoForward(): boolean {
    const view = this.getActiveWebContentsView();
    return Boolean(viewIsAlive(view) && view.webContents.canGoForward());
  }

  public async printActiveView(): Promise<void> {
    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) {
      this.showNoEmailSelectedDialog();
      return;
    }

    const isOpen = await this.isThreadOpen();
    if (!isOpen) {
      this.showNoEmailSelectedDialog();
      return;
    }

    const printUrl = await this.getAuthenticPrintUrl();
    if (printUrl) {
      const printed = await this.printUrl(printUrl);
      if (printed) return;
    }

    if (process.env.MAGIMAIL_E2E) {
      return;
    }
    view.webContents.print({ silent: false, printBackground: true }, () => {});
  }

  public async exportActiveThreadToPdf(): Promise<void> {
    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) {
      this.showNoEmailSelectedDialog();
      return;
    }

    const isOpen = await this.isThreadOpen();
    if (!isOpen) {
      this.showNoEmailSelectedDialog();
      return;
    }

    const subject = await this.getThreadSubject();
    const sanitized =
      subject
        .replace(/[/\\?%*:|"<>]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100) || 'Email';

    const { canceled, filePath } = await dialog.showSaveDialog(
      this.mainWindow as unknown as BrowserWindow,
      {
        title: uiString('dialog.exportPdf.title'),
        defaultPath: `${sanitized}.pdf`,
        filters: [{ name: uiString('dialog.exportPdf.filterName'), extensions: ['pdf'] }],
      },
    );
    if (canceled || !filePath) return;

    const printUrl = await this.getAuthenticPrintUrl();
    if (printUrl) {
      const printWin = await this.createPrintWindow(printUrl);
      if (printWin) {
        try {
          const pdfBuffer = await printWin.webContents.printToPDF({ printBackground: true });
          await fs.promises.writeFile(filePath, pdfBuffer);
          return;
        } finally {
          printWin.destroy();
        }
      }
    }

    const pdfBuffer = await view.webContents.printToPDF({ printBackground: true });
    await fs.promises.writeFile(filePath, pdfBuffer);
  }

  public async shareActiveThreadAsPdf(): Promise<void> {
    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) {
      this.showNoEmailSelectedDialog();
      return;
    }

    const isOpen = await this.isThreadOpen();
    if (!isOpen) {
      this.showNoEmailSelectedDialog();
      return;
    }

    const subject = await this.getThreadSubject();
    const sanitized =
      subject
        .replace(/[/\\?%*:|"<>]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100) || 'Email';

    let pdfBuffer: Buffer;
    const printUrl = await this.getAuthenticPrintUrl();
    if (printUrl) {
      const printWin = await this.createPrintWindow(printUrl);
      if (printWin) {
        try {
          pdfBuffer = await printWin.webContents.printToPDF({ printBackground: true });
        } finally {
          printWin.destroy();
        }
      } else {
        pdfBuffer = await view.webContents.printToPDF({ printBackground: true });
      }
    } else {
      pdfBuffer = await view.webContents.printToPDF({ printBackground: true });
    }

    // Removed once the sharing service has finished reading it. Deleting any sooner
    // would pull the file out from under a service still uploading it.
    const tempDir = createShareTempDir();
    const tempFilePath = await writeIntoShareTempDir(tempDir, `${sanitized}.pdf`, pdfBuffer);
    showNativeSharingPicker(this.mainWindow, [tempFilePath], () => removeShareTempDir(tempDir));
  }

  public async shareActiveThreadLink(): Promise<void> {
    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) {
      this.showNoEmailSelectedDialog();
      return;
    }

    const isOpen = await this.isThreadOpen();
    if (!isOpen) {
      this.showNoEmailSelectedDialog();
      return;
    }

    const url = (await this.getThreadUrl()) || view.webContents.getURL();
    showNativeSharingPicker(this.mainWindow, [url]);
  }

  public async copyActiveThreadLink(): Promise<void> {
    const view = this.getActiveWebContentsView();
    if (!viewIsAlive(view)) {
      this.showNoEmailSelectedDialog();
      return;
    }

    const isOpen = await this.isThreadOpen();
    if (!isOpen) {
      this.showNoEmailSelectedDialog();
      return;
    }

    const url = (await this.getThreadUrl()) || view.webContents.getURL();
    clipboard.writeText(url);
  }
}
