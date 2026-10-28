import {
  app,
  BaseWindow,
  WebContentsView,
  ipcMain,
  nativeTheme,
  session,
  shell,
  webFrameMain,
  type WebFrameMain,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  analyzeFrame,
  configureGoogleSession,
  isNetworkLoadFailure,
  offlinePageDataUrl,
  RendererPool,
  SUSPEND_NEVER,
  viewIsAlive,
} from '@magimail/core';
import { createLogger, redactUrl } from '@magimail/core/logger';
import { CALENDAR_BASE_URL, CALENDAR_LIST_CHANNEL, CALENDAR_LOGIN_URL } from './constants.js';
import { layoutCalendarView } from './window-layout.js';
import { uiString } from './strings.js';
import { getCalendarCss, getCalendarSubframeCss } from './calendar-css.js';
import { isInternalUrl, withoutQuery } from './links.js';
import { createAccount, loadAccounts, saveAccounts, type CalendarAccount } from './accounts.js';
import { DOMCalendarMetadataProvider } from './calendar-provider.js';
import { observeCalendarIds } from './calendar-identity.js';
import { observeSyncState } from './calendar-sync-state.js';
import { mergeCalendarList, resolveCalendarList, type RawCalendar } from './calendar-list.js';
import { loadSettings, saveSetting } from './settings-store.js';
import { preparePane, releaseDebugger, runImport, type IcsImportOutcome } from './ics-import.js';
import {
  createCalendarActionDriver,
  type CalendarActionDriver,
  type DomCalendarActionDriver,
  type RsvpResponse,
  type RsvpTiming,
} from './calendar-actions/index.js';
import { pathnameOf, viewModeForPath, type ViewMode } from './calendar-routes.js';

export type { ViewMode };

const log = createLogger('Accounts');

export { SUSPEND_NEVER };

/** Why an RSVP did or did not land. `busy` is retryable; `failed` is not. */
export type RsvpOutcome = 'ok' | 'busy' | 'failed';

/**
 * How far following a link got.
 *
 * `routed` is the useful middle: the view is on the event's day, which is most of what
 * the user wanted, so it is worth leaving them there rather than loading a URL over it.
 */
export type RevealOutcome = 'revealed' | 'routed' | 'busy' | 'failed';

/**
 * Deletes partition directories no configured account uses.
 *
 * An account id is a timestamp, so a removed account's partition is orphaned: nothing ever
 * signs in to it again, and its cookies are a Google session left on disk for the life of
 * the install. `removeAccount` clears the one it just removed; this catches a crash
 * between the two, and runs before any timestamp-named session is created so nothing holds
 * the files open. The fixed `magical_personal` partition is left alone.
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
    if (!entry.isDirectory() || !entry.name.startsWith('magical_account_')) continue;
    if (keep.has(entry.name)) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
      log.info(`Pruned the partition of a removed account: ${entry.name}`);
    } catch (err) {
      log.warn(`Could not prune the partition ${entry.name}:`, err);
    }
  }
}

/**
 * Magical's accounts and the web view each one owns.
 *
 * Lazily instantiates WebContentsViews on demand and suspends inactive ones
 * to keep memory footprint minimal, matching Magimail's architecture.
 */
export class AccountsManager {
  private accounts: CalendarAccount[] = loadAccounts();
  private activeAccountId: string = this.accounts[0]?.id ?? '';
  private readonly pool: RendererPool<CalendarAccount, WebContentsView>;
  /**
   * What each account's view was trying to load when the network took it out.
   *
   * Kept so reconnecting returns to the page the user was on rather than to the calendar
   * root; a link followed from a banner, or a month paged to, would otherwise be lost to
   * a dropped connection.
   */
  private failedOfflineUrls = new Map<string, string>();
  /** The key from the last `insertCSS` per view, so re-injecting replaces
   *  rather than stacks. */
  private injectedCss = new WeakMap<WebContentsView, string>();
  /** Serialisation queues for background actions per account, avoiding overlapping DOM mutations. */
  private actionQueues = new Map<string, Promise<unknown>>();
  /**
   * The disposer for each account's calendar-id observer.
   *
   * The listener sits on the partition's session, which outlives the account: without
   * holding the disposer, a removed account keeps a listener that mutates its dead record
   * and writes `accounts.json` on every request its partition ever sees again.
   */
  private calendarObservers = new Map<string, () => void>();
  /**
   * Which mode each account's view is in, kept per account so switching away and back
   * returns to the same one. Derived from the route, so a suspension and resume rebuilds
   * it from the URL the view comes back on rather than needing its own persistence.
   */
  private viewModes = new Map<string, ViewMode>();
  /** Views that have reported a finished page load, so a slow initial paint is not mistaken for a blank view. */
  private finishedLoadViews = new WeakSet<WebContentsView>();
  /** Timestamp of the last rebuild triggered by a dead frame, enforcing the cooldown. */
  private lastRebuildTime = 0;
  /** Timer for the follow-up presenting check scheduled after the window is shown. */
  private presentingCheckTimer?: ReturnType<typeof setTimeout>;

  /** Fired whenever the list, its order or an account's fields change, so the
   *  menu and the settings window can be rebuilt from one place. */
  public onAccountsChanged?: () => void;
  public onAccountSwitched?: (accountId: string) => void;
  /**
   * Fired as an account is removed, before its record is dropped.
   *
   * Before, because the caches that have to be purged are keyed by the id: the calendar
   * service sweeps what is no longer configured, and a purge asked for afterwards has
   * nothing left to tell it which account went.
   */
  public onAccountRemoving?: (accountId: string) => void;
  /**
   * Fired when the account on screen crosses between Calendar and Tasks, so a native
   * surface can reconfigure itself without polling the view. Never fired for a background
   * account: the mode that matters is the one in the window.
   */
  public onModeChanged?: (mode: ViewMode) => void;
  /** Fired when the active account's history moves, so the menu can follow it. */
  public onHistoryChanged?: () => void;

  /** RSVP, delete and task completion: the sync API first, the page as fallback. */
  private readonly actions: CalendarActionDriver;

  /** The page itself, for the work the sync API does not do. */
  private readonly dom: DomCalendarActionDriver;

  constructor(
    private mainWindow: BaseWindow,
    private preloadPath: string,
    options: { initialAccountId?: string } = {},
  ) {
    // Chosen before the first `switchAccount`, because that call is what builds and
    // loads an account's view.
    const initial = this.resolveInitialAccountId(options.initialAccountId);
    this.activeAccountId = initial.id;

    this.pool = new RendererPool<CalendarAccount, WebContentsView>(
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
          if (this.mainWindow.contentView.children.includes(view)) {
            this.mainWindow.contentView.removeChildView(view);
            log.info(`Detached view for account ${accountId} (${this.pool.attachedSummary()})`);
          }
        },
        // Magical holds nothing per view: the injected-CSS keys are a WeakMap keyed by the
        // view itself, so they go with it.
        onRelease: () => {},
        rememberUrl: (url) => {
          if (url.startsWith(CALENDAR_BASE_URL)) {
            // The offline cache matches the exact URL, so the query is dropped: the path,
            // which is where the date and the view mode live, stays.
            return withoutQuery(url);
          }
          if (url.startsWith('https://accounts.google.com')) {
            // The query is the whole request here: which service, and where to continue to.
            return url;
          }
          return undefined;
        },
      },
      {
        suspendDelayMinutes: loadSettings().inactiveAccountSuspendMinutes ?? 5,
        log,
      },
    );

    const stack = createCalendarActionDriver(
      {
        hasAccount: (accountId) => this.accounts.some((a) => a.id === accountId),
        activeAccountId: () => this.activeAccountId,
        viewMode: (accountId) => this.getViewMode(accountId),
        viewFor: (accountId) => this.pool.view(accountId),
        withActionLock: (accountId, label, run) =>
          this.withAccountActionLock(accountId, label, run),
        wake: (accountId, waitForLoad) => this.wakeAccountForAction(accountId, waitForLoad),
        waitForPage: (view, timeoutMs) => this.waitForPage(view, timeoutMs),
      },
      {
        getAccountContext: (accountId) => {
          const account = this.accounts.find((a) => a.id === accountId);
          if (!account) return undefined;
          const index = this.accounts.indexOf(account);
          return {
            id: account.id,
            partition: account.partition,
            accountIndex: index >= 0 ? index : 0,
            calendarIds: account.calendarIds,
            gaiaId: account.gaiaId,
            apiKey: account.apiKey,
            email: account.email,
          };
        },
      },
    );
    this.actions = stack.actions;
    this.dom = stack.dom;

    // Every partition is configured up front rather than on first view: the
    // clean User-Agent and header sanitisation have to be installed before any
    // request reaches Google, and a background account's first request can be
    // its sign-in.
    log.info(
      `Initialized AccountsManager with ${this.accounts.length} account(s), active=${this.activeAccountId} ` +
        `(requested=${options.initialAccountId ?? 'none'}, source=${initial.source})`,
    );
    pruneOrphanPartitions(this.accounts.map((a) => a.partition));
    for (const account of this.accounts) {
      configureGoogleSession(account.partition);
      this.observeCalendars(account);
    }
    this.receiveCalendarLists();

    this.mainWindow.on('resize', () => this.updateLayout());
    this.mainWindow.on('hide', () => this.handleWindowHidden());
    this.mainWindow.on('show', () => {
      this.pool.handleWindowShown();
      queueMicrotask(() => {
        if (!this.pool.isWindowVisible()) return;
        if (this.isAccountLoaded(this.activeAccountId)) return;
        this.switchAccount(this.activeAccountId);
      });
      this.schedulePresentingChecks();
    });
    this.switchAccount(this.activeAccountId);
  }

  // MARK: - Reading

  /** Resolves the account that owns a given webContents id, if any. */
  public getAccountIdForWebContentsId(webContentsId: number): string | undefined {
    for (const [accountId, view] of this.pool.entries()) {
      if (viewIsAlive(view) && view.webContents.id === webContentsId) {
        return accountId;
      }
    }
    return undefined;
  }

  public getAccounts(): CalendarAccount[] {
    return [...this.accounts];
  }

  public getActiveAccountId(): string {
    return this.activeAccountId;
  }

  public getActiveAccount(): CalendarAccount | undefined {
    return this.accounts.find((a) => a.id === this.activeAccountId);
  }

  public getActiveView(): WebContentsView | undefined {
    return this.pool.view(this.activeAccountId);
  }

  public goBack(): boolean {
    const view = this.getActiveView();
    if (viewIsAlive(view) && view.webContents.canGoBack()) {
      view.webContents.goBack();
      return true;
    }
    return false;
  }

  public goForward(): boolean {
    const view = this.getActiveView();
    if (viewIsAlive(view) && view.webContents.canGoForward()) {
      view.webContents.goForward();
      return true;
    }
    return false;
  }

  public canGoBack(): boolean {
    const view = this.getActiveView();
    return Boolean(viewIsAlive(view) && view.webContents.canGoBack());
  }

  public canGoForward(): boolean {
    const view = this.getActiveView();
    return Boolean(viewIsAlive(view) && view.webContents.canGoForward());
  }

  /**
   * The mode an account's view is in.
   *
   * Defaults to `calendar`: an account that has never navigated is on its way to the
   * grid, and answering `calendar` for it is what leaves an action that needs the grid
   * to run rather than route a view that is nowhere yet.
   */
  public getViewMode(accountId: string): ViewMode {
    return this.viewModes.get(accountId) ?? 'calendar';
  }

  /** The mode of the account on screen, which is the one a native surface follows. */
  public getActiveViewMode(): ViewMode {
    return this.getViewMode(this.activeAccountId);
  }

  /**
   * Drives one of Calendar's own toolbar controls.
   *
   * The page scripting lives in the driver; this wakes the account and hands over.
   */
  public async triggerCalendarAction(
    action: 'createEvent' | 'createTask' | 'navPrev' | 'navToday' | 'navNext' | 'search',
    targetAccountId?: string,
  ): Promise<boolean> {
    return this.dom.triggerCalendarAction(action, targetAccountId);
  }

  public async triggerNewTask(targetAccountId?: string): Promise<boolean> {
    return this.dom.triggerNewTask(targetAccountId);
  }

  // MARK: - Views

  private createAccountView(account: CalendarAccount): WebContentsView {
    configureGoogleSession(account.partition);

    const view = new WebContentsView({
      webPreferences: {
        // Without this preload the headers name branded Chrome while the page's
        // `navigator.userAgentData` still says Chromium, and Google blocks the
        // sign-in over the disagreement. `sandbox: false` matches Magimail's
        // account views, where the same preload is known to run.
        preload: this.preloadPath,
        partition: account.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: true,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor('#00000000');

    // At navigation commit, not `dom-ready`: the page is styled before its
    // first paint, so there is no flash of Google's own chrome.
    view.webContents.on('did-navigate', (_event, url) => {
      // The offline page is a `data:` URL carrying the whole document, so logging it
      // whole puts four kilobytes of escaped HTML in the log on every failed load.
      log.info(
        `Account ${account.id} navigated to:`,
        url.startsWith('data:') ? 'the offline page' : redactUrl(url),
      );
      this.injectCss(view);
      // The offline page is itself a `data:` navigation, so it must not clear the URL it
      // exists to retry.
      if (!url.startsWith('data:')) {
        this.failedOfflineUrls.delete(account.id);
        this.updateViewMode(account.id, url);
      }
      if (account.id === this.activeAccountId) this.onHistoryChanged?.();
    });

    // Calendar is a single-page app, so moving between the grid and full-screen Tasks, or
    // between dates and views, changes the path without loading a document. `did-navigate`
    // covers a real load; this covers the in-page transition, which is the commoner one.
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      this.updateViewMode(account.id, url);
      if (account.id === this.activeAccountId) this.onHistoryChanged?.();
    });

    // Chromium's own error page names a net:: code, offers a reload that fails the same
    // way, and never mentions Magical. Replace it with a page that says what cannot be
    // reached and retries the URL that actually failed.
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame || !isNetworkLoadFailure(errorCode)) return;
        log.warn(`Account ${account.id} could not load ${redactUrl(validatedURL)}: ${errorCode}`);
        this.failedOfflineUrls.set(account.id, validatedURL);
        this.renderOfflineError(view, validatedURL);
      },
    );

    // An event description's Drive attachments, Maps pins and ticket links go
    // to the browser. Without this they replace the calendar in a window with
    // no way back.
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isInternalUrl(url)) return { action: 'allow' };
      log.info('Opening external URL from window.open:', redactUrl(url));
      shell.openExternal(url);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => {
      if (isInternalUrl(url)) return;
      event.preventDefault();
      log.info('Redirecting navigation to external browser:', redactUrl(url));
      shell.openExternal(url);
    });

    // The Tasks embed is a cross-origin document the top-frame stylesheet
    // cannot reach, and it reloads on its own navigation.
    view.webContents.on(
      'did-frame-finish-load',
      (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame) return;
        const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
        if (frame) void this.injectSubframeCss(frame);
      },
    );

    view.webContents.on('did-finish-load', () => {
      this.finishedLoadViews.add(view);
      setTimeout(() => {
        void this.syncCalendarMetadata(account.id);
      }, 2500);
    });

    return view;
  }

  private renderOfflineError(view: WebContentsView, retryUrl: string): void {
    view.webContents
      .loadURL(
        offlinePageDataUrl(
          {
            appName: 'Magical',
            serviceName: 'Google Calendar',
            retryUrl,
            isDark: nativeTheme.shouldUseDarkColors,
          },
          uiString,
        ),
      )
      .catch(() => {});
  }

  /**
   * Reloads what the network took out, once it is back.
   *
   * The active account only. A suspended account has no view to reload, and one that is
   * merely off screen reloads when it is next switched to, which is soon enough and
   * costs nothing while the user is not looking at it.
   */
  public handleNetworkStatusChange(isOnline: boolean): void {
    if (!isOnline) return;
    const failedUrl = this.failedOfflineUrls.get(this.activeAccountId);
    if (!failedUrl) return;

    const view = this.pool.view(this.activeAccountId);
    if (!viewIsAlive(view)) return;

    log.info(`Back online; reloading ${redactUrl(failedUrl)}`);
    this.failedOfflineUrls.delete(this.activeAccountId);
    view.webContents.loadURL(failedUrl).catch(() => {});
  }

  /** The window's `hide`, and a window built hidden, which fires no event. */
  public handleWindowHidden(): void {
    this.cancelPresentingCheck();
    this.pool.handleWindowHidden();
  }

  /** Apply a new inactivity threshold from Settings. */
  public setSuspendDelayMinutes(minutes: number): void {
    this.pool.setSuspendDelayMinutes(minutes);
  }

  /** Tear down every account view that isn't needed right now. Used on quit. */
  public suspendAllAccounts(): void {
    this.pool.suspendAllAccounts();
  }

  /** Whether an account currently has a live renderer. */
  public isAccountLoaded(accountId: string): boolean {
    return this.pool.isAccountLoaded(accountId);
  }

  /**
   * Injects the Tasks embed stylesheet into one child frame. Only
   * tasks.google.com frames are touched; the apps menu and contact hovercard
   * frames share the event but have no business with this sheet.
   */
  private async injectSubframeCss(frame: WebFrameMain): Promise<void> {
    if (frame.isDestroyed() || !frame.url.startsWith('https://tasks.google.com/')) return;
    const css = getCalendarSubframeCss({
      transparent: loadSettings().transparentBackground,
    });
    if (!css) return;
    const code = `(()=>{try{let s=document.getElementById('magical-subframe-styles');if(!s){s=document.createElement('style');s.id='magical-subframe-styles';(document.head||document.documentElement).appendChild(s);}s.textContent=${JSON.stringify(css)};}catch(e){}})()`;
    try {
      await frame.executeJavaScript(code);
    } catch {
      // The frame can navigate away between the event and this call.
    }
  }

  private injectAllSubframes(view: WebContentsView): void {
    const root = view.webContents.mainFrame;
    if (!root) return;
    const walk = (frame: WebFrameMain): void => {
      if (!frame || frame.isDestroyed()) return;
      for (const child of frame.frames) {
        void this.injectSubframeCss(child);
        walk(child);
      }
    };
    walk(root);
  }

  private injectCss(view: WebContentsView): void {
    if (!viewIsAlive(view)) return;

    const settings = loadSettings();
    const css = getCalendarCss({
      transparent: settings.transparentBackground,
      hideSidebar: settings.hideSidebar,
      hideTasksTab: settings.hideTasksTab,
    });

    // Removed before the new sheet goes in, so toggling a setting replaces the
    // CSS rather than stacking a second copy whose !important rules would win.
    const previous = this.injectedCss.get(view);
    if (previous) {
      view.webContents.removeInsertedCSS(previous).catch(() => {});
    }
    view.webContents
      .insertCSS(css, { cssOrigin: 'user' })
      .then((key) => {
        this.injectedCss.set(view, key);
        // The Tasks embed is a separate document; re-apply its sheet too, so a
        // transparency toggle reaches it without a reload.
        this.injectAllSubframes(view);
      })
      // Google Calendar then renders on its own canvas under vibrancy, which
      // the user reports as washed-out or unreadable rather than as a failure.
      .catch((err) => log.error('Could not inject the calendar CSS:', err));
  }

  /** Re-applies the canvas CSS everywhere. Called when a setting changes. */
  public reinjectCss(): void {
    for (const [, view] of this.pool.entries()) {
      this.injectCss(view);
    }
  }

  /**
   * Leaves the full-screen Tasks route for the calendar, if the active account is on it.
   *
   * Called when "Hide Tasks tab" is switched on: the switcher that would take the user
   * back is now hidden, so leaving them on the Tasks page strands them. The route is the
   * driver's.
   */
  public leaveTasksRouteIfActive(): void {
    const view = this.pool.view(this.activeAccountId);
    if (!viewIsAlive(view)) return;

    void this.dom
      .leaveTasksRouteIfActive(view)
      .catch((err) => log.error('Could not leave the Tasks route:', err));
  }

  public updateLayout(): void {
    const [width, height] = this.mainWindow.getContentSize();
    const bounds = layoutCalendarView(width, height);
    for (const [, view] of this.pool.entries()) {
      view.setBounds(bounds);
    }
  }

  /**
   * Serialises background actions on an account's view.
   *
   * Multiple actions on the same account (for instance, responding to two rapid alerts or
   * deleting during an RSVP retry) must not fight over view attachment, history routing,
   * or previous-path restoration.
   */
  private async withAccountActionLock<T>(
    accountId: string,
    actionName: string,
    actionFn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.actionQueues.get(accountId);
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.actionQueues.set(
      accountId,
      previous ? previous.then(() => current).catch(() => current) : current,
    );

    if (previous) {
      await previous.catch(() => {});
    }
    try {
      return await actionFn();
    } finally {
      release();
      if (this.actionQueues.get(accountId) === current) {
        this.actionQueues.delete(accountId);
      }
    }
  }

  /**
   * Attach a view to the window for the length of a background action, and return the
   * undo.
   *
   * Answering an invitation or deleting an event happens in an account the user is not
   * looking at, and `switchAccount` detaches every view but the one on screen. A view
   * with no parent lays out at nothing however its bounds are set, and Calendar draws
   * for the size it is given: no event chip and no RSVP control exist in a viewport of
   * zero, so the action finds nothing to click.
   *
   * It goes in at the bottom of the stack with the same bounds as the account on
   * screen, and is kept hidden while it is there. Those bounds let the renderer lay
   * out at the window's size, but the view contributes nothing to the screen: one
   * calendar is never drawn over another, even while the page above it is still
   * transparent before its first paint.
   */
  private attachForBackgroundAction(view: WebContentsView, accountId: string): () => void {
    // A view that is already attached is left where it is: that is the account on
    // screen, normally. It is not attached while the window is hidden, though — the
    // active account is suspended then too — so a detached view is attached below
    // whichever account it is.
    if (this.mainWindow.contentView.children.includes(view)) return () => {};

    const [width, height] = this.mainWindow.getContentSize();
    view.setBounds(layoutCalendarView(width, height));
    if (typeof view.setVisible === 'function') {
      view.setVisible(false);
    }
    this.mainWindow.contentView.addChildView(view, 0);
    log.info(
      `Attached view for background action on account ${accountId} at index 0 (${this.pool.attachedSummary()})`,
    );
    view.webContents.setBackgroundThrottling(false);

    return () => {
      if (!viewIsAlive(view)) return;
      // The user may have switched to this account while the action ran.
      if (accountId === this.activeAccountId) {
        if (typeof view.setVisible === 'function') {
          view.setVisible(true);
        }
        return;
      }
      view.webContents.setBackgroundThrottling(true);
      if (this.mainWindow.contentView.children.includes(view)) {
        this.mainWindow.contentView.removeChildView(view);
        log.info(
          `Detached view for background action on account ${accountId} (${this.pool.attachedSummary()})`,
        );
      }
      if (typeof view.setVisible === 'function') {
        view.setVisible(true);
      }
    };
  }

  // MARK: - Switching

  /** The renderer an action needs, waking a suspended account behind it. */
  private wakeAccountForAction(
    accountId: string,
    waitForLoad = true,
  ): Promise<{ view: WebContentsView; release: () => void } | undefined> {
    return this.pool.wakeForAction(accountId, {
      loginUrl: CALENDAR_LOGIN_URL,
      attachForAction: (view) => this.attachForBackgroundAction(view, accountId),
      waitForLoad: waitForLoad ? (view) => this.waitForPage(view) : undefined,
    });
  }

  /**
   * Waits for the document to finish loading, without assuming which route it is on.
   *
   * `waitForCalendar` asks for a grid, which the search and editor routes do not have;
   * a toolbar action can run on any of them. This is the floor every action needs.
   */
  private async waitForPage(view: WebContentsView, timeoutMs = 15_000): Promise<boolean> {
    const wc = view.webContents;
    if (wc.isDestroyed()) return false;
    if (!wc.isLoading()) return true;

    return new Promise<boolean>((resolve) => {
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
  }

  /**
   * Answers an invitation using CalendarActionDriver (sync API first, DOM fallback).
   */
  public async performRsvp(
    accountId: string,
    eid: string,
    response: RsvpResponse,
    startTime: Date,
    timing?: RsvpTiming,
  ): Promise<RsvpOutcome> {
    const view = this.pool.view(accountId);
    return this.actions.performRsvp(view, accountId, eid, response, startTime, timing);
  }

  /**
   * Shows one event in its own account's view, with its detail panel open.
   *
   * What a banner does when the user clicks its body.
   */
  public async revealEvent(accountId: string, eid: string, at: Date): Promise<RevealOutcome> {
    return this.dom.revealEvent(this.pool.view(accountId), accountId, eid, at);
  }

  /**
   * Deletes an event using CalendarActionDriver (sync API first, DOM fallback).
   */
  public async deleteEvent(
    accountId: string,
    eid: string,
    startTime: Date,
    isTask = false,
  ): Promise<'ok' | 'busy' | 'failed'> {
    const view = this.pool.view(accountId);
    return this.actions.deleteEvent(view, accountId, eid, startTime, isTask);
  }

  /**
   * Ticks a task off in Google Tasks, or ticks it back open, using CalendarActionDriver.
   */
  public async setTaskCompleted(
    accountId: string,
    eid: string,
    startTime: Date,
    completed: boolean,
  ): Promise<'ok' | 'busy' | 'failed'> {
    const view = this.pool.view(accountId);
    return this.actions.setTaskCompleted(view, accountId, eid, startTime, completed);
  }

  /**
   * Records an account's mode from a navigation and tells the window when it matters.
   *
   * A missing previous value counts as `calendar`, so the first navigation into Tasks is
   * a transition and fires once; the first into the grid is not, because that is already
   * the default a surface starts on. Only the account on screen is announced: the mode a
   * background account is in changes nothing the user can see.
   */
  private updateViewMode(accountId: string, url: string): void {
    const next = viewModeForPath(pathnameOf(url));
    const previous = this.viewModes.get(accountId) ?? 'calendar';
    this.viewModes.set(accountId, next);
    if (previous === next) return;
    log.info(`Account ${accountId} view mode: ${previous} -> ${next}`);
    if (accountId === this.activeAccountId) this.onModeChanged?.(next);
  }

  /**
   * Selects an account and points its view at a URL.
   *
   * Two steps that only make sense together, so callers name both once rather than
   * sequencing them: `switchAccount` selects the account and wakes its renderer (loading
   * `resumeUrl`), and the load then replaces that with the destination. A deep link that
   * names an account but skipped the switch would land the URL in whichever account
   * happened to be on screen.
   *
   * A navigation rather than a new window: the event opens where the user already reads
   * their calendar.
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

  /**
   * The account the first view should be built for.
   *
   * A cold-launch link wins, because it names what the user asked to see. Without
   * one the last active account is restored, which is what a normal relaunch should
   * do. A request naming an account that no longer exists falls through to the first
   * account, because the account list is authoritative.
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

  public switchAccount(accountId: string): void {
    const targetAccount = this.accounts.find((a) => a.id === accountId);
    if (!targetAccount) return;

    log.info(`Switching active account to ${accountId}`);
    this.activeAccountId = accountId;
    const activeView = this.pool.attachOnly(accountId);
    if (!activeView) return;

    this.updateLayout();

    // Load URL only after view is attached and has full window bounds. A
    // resumed account returns to where it was rather than to the default view.
    const firstLoad = this.pool.firstLoadUrl(accountId, CALENDAR_LOGIN_URL);
    if (firstLoad) activeView.webContents.loadURL(firstLoad);

    this.onAccountsChanged?.();
    this.onAccountSwitched?.(accountId);
  }

  public switchToIndex(index: number): void {
    const account = this.accounts[index];
    if (account) this.switchAccount(account.id);
  }

  // MARK: - Editing

  public addAccount(name?: string, color?: string): CalendarAccount {
    const account = createAccount(name?.trim() || 'New Account', this.accounts);
    if (color) account.color = color;

    log.info(`Adding account ${account.id}`);
    this.accounts.push(account);
    saveAccounts(this.accounts);
    configureGoogleSession(account.partition);
    this.observeCalendars(account);

    // Switched to immediately: a new account's entire purpose is the sign-in
    // sitting behind it, and leaving it in the background makes adding one look
    // like it did nothing.
    this.switchAccount(account.id);
    this.onAccountsChanged?.();
    return account;
  }

  public removeAccount(accountId: string): boolean {
    // The last account cannot go — there would be nothing to show.
    if (this.accounts.length <= 1) return false;
    const index = this.accounts.findIndex((a) => a.id === accountId);
    if (index === -1) return false;

    log.info(`Removing account ${accountId}`);
    this.onAccountRemoving?.(accountId);
    this.pool.removeView(accountId);
    this.failedOfflineUrls.delete(accountId);
    this.actionQueues.delete(accountId);
    // A mode belongs to the account record; an entry left behind would be read back if
    // the same id were ever reused.
    this.viewModes.delete(accountId);
    // The partition and its cookies stay on disk deliberately, but the observer does not:
    // it belongs to a record that no longer exists.
    this.calendarObservers.get(accountId)?.();
    this.calendarObservers.delete(accountId);
    const removedPartition = this.accounts[index].partition;

    this.accounts.splice(index, 1);
    saveAccounts(this.accounts);

    // The account id is a timestamp, so this partition is never signed in to again: its
    // cookies are a Google session left on disk for the life of the install, and a re-add
    // gets a new id and a new partition. Clearing removes the credential now; the
    // directory itself is swept on the next launch. Nothing is recoverable by keeping it.
    const ses = session.fromPartition(removedPartition);
    void ses.clearStorageData().catch((err) => {
      log.warn(`Could not clear the session for the removed account ${accountId}:`, err);
    });
    void ses.clearCache().catch(() => {});

    if (this.activeAccountId === accountId) {
      this.switchAccount(this.accounts[Math.min(index, this.accounts.length - 1)].id);
    }
    this.onAccountsChanged?.();
    return true;
  }

  /**
   * Records the calendars an account's view asks Google for.
   *
   * Set up once per partition, alongside the session configuration, because the
   * observation has to be in place before the view's first request — that request is
   * often the only one naming the full set. Merges rather than replaces: a single
   * request may name just one subscribed calendar.
   */
  private observeCalendars(account: CalendarAccount): void {
    this.calendarObservers.get(account.id)?.();

    const stopIds = observeCalendarIds(account.partition, (calendarIds) => {
      const known = account.calendarIds ?? [];
      const merged = [...known];
      for (const id of calendarIds) if (!merged.includes(id)) merged.push(id);
      if (merged.length === known.length) return;

      account.calendarIds = merged;
      saveAccounts(this.accounts);
      this.onCalendarIdsChanged?.(account.id, merged);
    });

    // The same view's `sync.sync` traffic carries the sync state a direct write reuses;
    // see `calendar-sync-state.ts`.
    const stopSyncState = observeSyncState(account.partition);

    this.calendarObservers.set(account.id, () => {
      stopIds();
      stopSyncState();
    });
  }

  /**
   * Takes the calendar list a view reports out of its own sync response.
   *
   * The sender decides which account this is, not the message: a renderer naming its own
   * account could name another's, and the view is already the account.
   *
   * This is better than what the DOM extraction produces and overwrites it. The extraction
   * stays for the window before a view has been served a full sync, which is the only
   * response carrying the list -- later ones are deltas.
   */
  private receiveCalendarLists(): void {
    ipcMain.on(
      CALENDAR_LIST_CHANNEL,
      (
        event,
        payload: RawCalendar[] | { calendars?: RawCalendar[]; gaiaId?: string; apiKey?: string },
      ) => {
        const raw = Array.isArray(payload) ? payload : (payload?.calendars ?? []);
        const gaiaId = !Array.isArray(payload) ? payload?.gaiaId : undefined;
        const apiKey = !Array.isArray(payload) ? payload?.apiKey : undefined;

        const entry = [...this.pool.entries()].find(
          ([, view]) => viewIsAlive(view) && view.webContents === event.sender,
        );
        if (!entry) return;
        const [accountId] = entry;
        const account = this.accounts.find((a) => a.id === accountId);
        if (!account) return;

        let changed = false;

        if (gaiaId && account.gaiaId !== gaiaId) {
          account.gaiaId = gaiaId;
          changed = true;
        }

        if (apiKey && account.apiKey !== apiKey) {
          account.apiKey = apiKey;
          changed = true;
        }

        if (Array.isArray(raw) && raw.length > 0) {
          const calendars = mergeCalendarList(
            account.calendars ?? [],
            resolveCalendarList(raw),
            account.color,
          );

          if (JSON.stringify(account.calendars ?? []) !== JSON.stringify(calendars)) {
            account.calendars = calendars;
            const knownIds = new Set(account.calendarIds ?? []);
            for (const cal of calendars) knownIds.add(cal.id);
            account.calendarIds = [...knownIds];
            changed = true;
          }
        }

        if (changed) {
          saveAccounts(this.accounts);
          log.info(`Account ${accountId} updated calendars/identity from its own view`);
          this.onAccountsChanged?.();
        }
      },
    );
  }

  /**
   * Adds the calendars only the rendered sidebar knows about.
   *
   * Birthdays and Tasks are shown there and are in no list Google sends, so without this
   * an account has no name or colour for either, and a contact's birthday falls back to
   * the account's own colour.
   *
   * It adds and never updates. Everything else comes from the page's own data, which
   * states the name Google shows and the colour it paints; this runs 2.5 seconds later,
   * and overwriting from the sidebar put a calendar's colour back to a value measured to
   * differ from what Google paints.
   */
  public async syncCalendarMetadata(accountId: string): Promise<void> {
    if (this.mainWindow.isDestroyed?.()) return;
    const account = this.accounts.find((a) => a.id === accountId);
    const view = this.pool.view(accountId);
    if (!account || !viewIsAlive(view)) return;

    try {
      const provider = new DOMCalendarMetadataProvider(view);
      const calendars = await provider.fetchCalendars();
      if (this.mainWindow.isDestroyed?.() || !viewIsAlive(view)) return;
      if (!calendars || calendars.length === 0) return;

      const current = account.calendars ?? [];
      const updatedMap = new Map(current.map((c) => [c.id, c]));
      let hasChanges = false;

      // Only the calendars nothing else reports. `calendar-list.ts` reads the rest off the
      // page Google served, which states the name it shows and the colour it paints;
      // this runs later and would otherwise overwrite both with what the sidebar renders,
      // which has been measured wrong on colour. What it alone can see is Birthdays and
      // Tasks: Google shows them in the sidebar and serves neither as a calendar.
      for (const cal of calendars) {
        if (updatedMap.has(cal.id)) continue;
        hasChanges = true;
        updatedMap.set(cal.id, {
          id: cal.id,
          name: cal.name || cal.id,
          color: cal.color || account.color,
        });
      }

      if (hasChanges || !account.calendars) {
        account.calendars = Array.from(updatedMap.values());
        const knownIds = new Set(account.calendarIds ?? []);
        for (const cal of account.calendars) {
          knownIds.add(cal.id);
        }
        account.calendarIds = Array.from(knownIds);

        saveAccounts(this.accounts);
        this.onAccountsChanged?.();
      }
    } catch (e) {
      // Settings then lists calendars by raw id instead of by name.
      log.warn(`Could not sync calendar metadata for ${accountId}:`, e);
    }
  }

  /** Fired when an account's calendar set grows, so a running poller can pick it up. */
  public onCalendarIdsChanged?: (accountId: string, calendarIds: string[]) => void;

  public updateAccount(accountId: string, fields: { name?: string; color?: string }): void {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;

    const name = fields.name?.trim();
    if (name) account.name = name;
    if (fields.color) account.color = fields.color;

    saveAccounts(this.accounts);
    this.onAccountsChanged?.();
  }

  public reorderAccounts(accountIds: string[]): void {
    const reordered = accountIds
      .map((id) => this.accounts.find((a) => a.id === id))
      .filter((a): a is CalendarAccount => a !== undefined);
    if (reordered.length !== this.accounts.length) return;
    this.accounts = reordered;
    saveAccounts(this.accounts);
    this.onAccountsChanged?.();
  }

  /** Clears one partition's cookies and storage without touching the others. */
  public async resetSession(accountId: string): Promise<void> {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account) return;

    log.info(`Resetting session data for account ${accountId}`);
    this.pool.forgetSuspendedUrl(accountId);
    await session.fromPartition(account.partition).clearStorageData();

    const view = this.pool.view(accountId);
    if (viewIsAlive(view)) {
      view.webContents.loadURL(CALENDAR_LOGIN_URL);
    }
  }

  public reloadActive(): void {
    void this.reloadAccount(this.activeAccountId);
  }

  private async reloadAccount(accountId: string): Promise<void> {
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

  /**
   * Rebuilds an account view from scratch through the pool.
   *
   * Closes the dead WebContents, creates a fresh replacement view,
   * updates layout, and navigates it back to the route the user was on.
   */
  public rebuildAccountView(accountId: string): WebContentsView | undefined {
    log.info(`Rebuilding account view for ${accountId}`);
    this.pool.removeView(accountId, { rememberUrl: true });
    const view = this.pool.attachOnly(accountId);
    if (!view) return undefined;

    this.updateLayout();

    const firstLoad = this.pool.firstLoadUrl(accountId, CALENDAR_LOGIN_URL);
    if (firstLoad) view.webContents.loadURL(firstLoad);

    this.onAccountsChanged?.();
    return view;
  }

  /**
   * Checks whether the active view on screen is presenting properly.
   *
   * If the view reports a loaded page but captures as a single uniform colour
   * (transparent or blank), it has stopped presenting. We rebuild it through
   * the pool, subject to a 1-minute cooldown to avoid mistaking slow loads for it.
   */
  public async checkActiveViewPresenting(): Promise<boolean> {
    if (!this.pool.isWindowVisible()) return false;
    if (typeof this.mainWindow.isDestroyed === 'function' && this.mainWindow.isDestroyed()) {
      return false;
    }

    const accountId = this.activeAccountId;
    const view = this.getActiveView();
    if (!view || !viewIsAlive(view)) return false;

    // Treat as dead only when the view reports a finished load.
    const isLoaded = this.finishedLoadViews.has(view) && !view.webContents.isLoading();
    if (!isLoaded) return false;

    // Cooldown: at most one rebuild per minute.
    if (Date.now() - this.lastRebuildTime < 60_000) return false;

    if (typeof view.webContents.capturePage !== 'function') return false;

    try {
      const image = await view.webContents.capturePage();
      if (!viewIsAlive(view) || !this.pool.isWindowVisible()) return false;

      const captureResult = analyzeFrame(image);
      if (!captureResult.uniform) return false;

      const windowBounds =
        typeof this.mainWindow.getBounds === 'function'
          ? this.mainWindow.getBounds()
          : { x: 0, y: 0, width: 0, height: 0 };
      const viewBounds =
        typeof view.getBounds === 'function'
          ? view.getBounds()
          : { x: 0, y: 0, width: 0, height: 0 };

      log.warn(
        `Account view for ${accountId} is not presenting (uniform frame); rebuilding view. ` +
          `window bounds: ${JSON.stringify(windowBounds)}, ` +
          `view bounds: ${JSON.stringify(viewBounds)}, ` +
          `capture: ${JSON.stringify(captureResult)}`,
      );

      this.lastRebuildTime = Date.now();
      this.rebuildAccountView(accountId);
      return true;
    } catch (err) {
      log.warn(`Could not verify presenting state for account ${accountId}:`, err);
      return false;
    }
  }

  private schedulePresentingChecks(): void {
    this.cancelPresentingCheck();
    void this.checkActiveViewPresenting();
    const timer = setTimeout(() => {
      this.presentingCheckTimer = undefined;
      void this.checkActiveViewPresenting();
    }, 3000);
    timer.unref?.();
    this.presentingCheckTimer = timer;
  }

  private cancelPresentingCheck(): void {
    if (this.presentingCheckTimer) {
      clearTimeout(this.presentingCheckTimer);
      this.presentingCheckTimer = undefined;
    }
  }

  // MARK: - Importing

  /**
   * Imports an `.ics` file into one account, through Google Calendar's own Import pane.
   *
   * The pane is driven in a view of its own rather than in the account's, so the user's
   * calendar stays on the day they were looking at. That view shares the account's
   * partition, so it is the same signed-in session Google sees; it is never added to the
   * window, and it is destroyed either way.
   *
   * When the pane cannot be driven to a confirmed result, the same pane is put on screen
   * in the account's own view with the file already in its input. A changed page then
   * costs the user a click rather than the feature.
   */
  public async importIcsFile(accountId: string, filePath: string): Promise<IcsImportOutcome> {
    const account = this.accounts.find((a) => a.id === accountId);
    if (!account)
      return { kind: 'unconfirmed', reason: uiString('dialog.ics.reason.accountMissing') };

    log.info(`Importing an .ics file into account ${accountId}`);
    const worker = this.createAccountView(account);
    // Laid out, though never shown: Google renders the pane against the viewport, and a
    // zero-sized one leaves the controls unrendered for the selectors to miss.
    const [width, height] = this.mainWindow.getContentSize();
    worker.setBounds(layoutCalendarView(width, height));

    let outcome: IcsImportOutcome;
    try {
      outcome = await runImport(worker, filePath);
    } catch (error) {
      log.error('Import failed while driving the pane:', error);
      outcome = { kind: 'unconfirmed', reason: uiString('dialog.ics.reason.paneUnavailable') };
    } finally {
      releaseDebugger(worker);
      if (viewIsAlive(worker)) worker.webContents.close();
    }

    if (outcome.kind === 'unconfirmed') await this.revealImportPane(accountId, filePath);
    return outcome;
  }

  /**
   * Shows the Import pane in the account's own view, file already loaded.
   *
   * The fallback, and deliberately a full navigation: the user is being handed a page to
   * finish by hand, so it has to be the page they are looking at.
   */
  private async revealImportPane(accountId: string, filePath: string): Promise<void> {
    this.switchAccount(accountId);
    const view = this.pool.view(accountId);
    if (!viewIsAlive(view)) return;

    log.info(`Falling back to the on-screen import pane for account ${accountId}`);
    try {
      await preparePane(view, filePath);
    } catch (error) {
      log.error('Could not prepare the on-screen import pane:', error);
    } finally {
      releaseDebugger(view);
    }
  }
}

/** Where the account preload is, relative to the bundled `dist/`. */
export function calendarPreloadPath(): string {
  const preload = path.join(__dirname, 'calendar-preload.js');
  // Returned either way, because there is nothing better to return. Without
  // the preload nothing sets the Chrome identity and no IPC comes back from
  // the page, and nothing else in the app would ever point here.
  if (!fs.existsSync(preload)) {
    log.error(`No preload script at ${preload}; the account views will not report back`);
  }
  return preload;
}
