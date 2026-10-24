import type { BaseWindow, WebContentsView } from 'electron';
import { viewIsAlive } from './window.js';

/**
 * The inactivity threshold that means "never release a view".
 *
 * Named rather than spelled `0` at every guard, because it is the value the Settings
 * control's "Never" writes and the value each guard compares against.
 */
export const SUSPEND_NEVER = 0;

/** The part of a logger the pool uses. The app passes its own, so its lines keep that app's scope. */
export interface RendererPoolLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

/**
 * What a `RendererPool` needs from the app that owns the accounts.
 *
 * Every member is either a read of app state or a write into a surface the app owns. The pool
 * owns the views and the timers; the app owns the accounts, their partitions, and the DOM work
 * each view carries.
 */
export interface RendererPoolSpec<Account, View extends WebContentsView> {
  /** The window whose contentView the views attach to. */
  window: () => BaseWindow;

  /** The account a view is being built for, or undefined when the id is not configured. */
  accountFor: (accountId: string) => Account | undefined;

  /** The account on screen, which is the one a visible window spares from the timer. */
  activeAccountId: () => string;

  /** Builds a view for an account that has none: partition, preload, webPreferences. */
  createView: (account: Account) => View;

  /** Adds the view to the window, if it is not there already. */
  attach: (accountId: string, view: View) => void;

  /** Takes the view off the window, if it is there. */
  detach: (accountId: string, view: View) => void;

  /** Releases what the app holds per view: injected CSS, DOM reports, a banner. */
  onRelease: (accountId: string, view: View) => void;

  /** The URL to remember for a view being released, or undefined to remember none. */
  rememberUrl: (url: string) => string | undefined;
}

export interface RendererPoolOptions {
  /** Minutes of inactivity before a view is released. `SUSPEND_NEVER` keeps them all resident. */
  suspendDelayMinutes: number;

  /** The app's logger. Absent means the pool reports nothing. */
  log?: RendererPoolLogger;
}

/** What a background action needs to reach an account's page, as the app holds it. */
export interface WakeForActionOptions<View> {
  /** Where a view with no page behind it is pointed: the app's own sign-in page. */
  loginUrl: string;

  /** Attaches the view for the length of the action, and returns the undo. */
  attachForAction: (view: View) => () => void;

  /** Awaited for a view this call woke. Absent to hand it over without waiting. */
  waitForLoad?: (view: View) => Promise<boolean>;

  /** Awaited for a view that already had a page, which an action may still find mid-load. */
  waitForReady?: (view: View) => Promise<void>;
}

/**
 * The account views both apps host, and the rules that decide how long each one lives.
 *
 * An account's renderer is the largest thing either app holds — measured at ~250–350MB — so a
 * view exists only while its account is on screen or recently was, and a released one has had
 * its `WebContents` closed. Both apps answer the same questions about that (is the window
 * visible, is this the account on screen, how long has it been idle), and a guard computed
 * against one app's own copy of the answer is not a guard for the other's. This is the one
 * owner: what "releasable" means is decided here, and is therefore the same in both apps.
 *
 * What is *not* here is everything the two apps do differently: which accounts exist, what
 * "active" carries (a toolbar, unread totals, a calendar mode), where a released view was
 * looking, and what the app must let go of alongside a view. Those arrive through the spec.
 */
export class RendererPool<Account, View extends WebContentsView> {
  private readonly views = new Map<string, View>();
  /** Accounts whose view has a page behind it, so showing one again costs no reload. */
  private readonly loadedAccounts = new Set<string>();
  /** Pending teardowns, keyed by account. Armed on deactivation, cleared on reactivation. */
  private readonly suspendTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Where each suspended account was last looking, so resuming restores it. */
  private readonly suspendedUrls = new Map<string, string>();
  /** Whether the main window is on screen. Hidden until the window's own `show`. */
  private windowVisible = false;
  private suspendDelayMinutes: number;
  private readonly log: RendererPoolLogger;

  constructor(
    private readonly spec: RendererPoolSpec<Account, View>,
    options: RendererPoolOptions,
  ) {
    this.suspendDelayMinutes = options.suspendDelayMinutes;
    this.log = options.log ?? { info: () => {}, warn: () => {} };
  }

  // MARK: - Reading

  /**
   * The account's view, live or not.
   *
   * The map read rather than a guard: a caller that needs a usable view asks `viewIsAlive`,
   * and one that wants a view built for an account that has none goes through `attachOnly`.
   */
  public view(accountId: string): View | undefined {
    return this.views.get(accountId);
  }

  /** Every view, in the order its account was first opened. */
  public entries(): IterableIterator<[string, View]> {
    return this.views.entries();
  }

  /** Whether an account currently has a live renderer. */
  public isAccountLoaded(accountId: string): boolean {
    return viewIsAlive(this.views.get(accountId));
  }

  /** Whether the main window is on screen. */
  public isWindowVisible(): boolean {
    return this.windowVisible;
  }

  /**
   * The URL an account's view must load the first time it is shown, consumed on read.
   *
   * Where the account was last looking, or `fallback` when it has never been released.
   * Undefined once its view has a page behind it, so switching back to a live account costs
   * no load.
   */
  public firstLoadUrl(accountId: string, fallback: string): string | undefined {
    if (this.loadedAccounts.has(accountId)) return undefined;
    this.loadedAccounts.add(accountId);
    return this.takeSuspendedUrl(accountId) ?? fallback;
  }

  /** Drops what was remembered for an account, so its next view starts at the app's own page. */
  public forgetSuspendedUrl(accountId: string): void {
    this.suspendedUrls.delete(accountId);
  }

  // MARK: - Views

  /**
   * Puts one account's view on screen and takes every other account's off it.
   *
   * Only the account on screen is ever a child of contentView: an account view is transparent
   * until its page paints, so two attached at once would composite together. The others come
   * off first and start ageing towards suspension, which is also when Chromium may begin
   * throttling their timers. Returns undefined for an account that is not configured.
   */
  public attachOnly(accountId: string): View | undefined {
    this.cancelSuspend(accountId);
    const view = this.ensureView(accountId);

    for (const [id, other] of this.views) {
      if (id === accountId) continue;
      this.detachView(id, other);
      this.scheduleSuspend(id);
    }

    if (view) {
      this.spec.attach(accountId, view);
      if (viewIsAlive(view)) view.webContents.setBackgroundThrottling(false);
    }
    return view;
  }

  /**
   * Drops an account's view for good: off the window, forgotten, and closed.
   *
   * Nothing is remembered for it. An account that is gone has no page to return to, and a
   * remembered URL left behind would be restored if the same id were ever reused.
   */
  public removeView(accountId: string): void {
    this.cancelSuspend(accountId);
    this.forgetSuspendedUrl(accountId);
    this.loadedAccounts.delete(accountId);

    const view = this.views.get(accountId);
    if (!view) return;

    this.spec.detach(accountId, view);
    this.views.delete(accountId);
    this.spec.onRelease(accountId, view);
    if (viewIsAlive(view)) view.webContents.close();
  }

  /** The account's view, created on demand. Undefined for an account that is not configured. */
  private ensureView(accountId: string): View | undefined {
    const existing = this.views.get(accountId);
    if (viewIsAlive(existing)) return existing;

    const account = this.spec.accountFor(accountId);
    if (!account) return undefined;

    this.log.info(`Creating WebContentsView for account ${accountId}`);
    const view = this.spec.createView(account);
    this.views.set(accountId, view);
    return view;
  }

  /** Takes an account's view off the window and hands its timers back to Chromium. */
  private detachView(accountId: string, view: View): void {
    this.spec.detach(accountId, view);
    if (viewIsAlive(view)) view.webContents.setBackgroundThrottling(true);
  }

  // MARK: - Suspension

  /**
   * Applies the hidden state: the account on screen starts ageing out.
   *
   * Called by the window's `hide` event and by an app that built its window hidden, which
   * fires no event. Without the second, a window built for an action that arrived with none
   * would keep its account resident for the life of the app.
   */
  public handleWindowHidden(): void {
    this.windowVisible = false;
    this.scheduleSuspend(this.spec.activeAccountId());
  }

  /** Applies the visible state: the account on screen is spared the timer again. */
  public handleWindowShown(): void {
    this.windowVisible = true;
    this.cancelSuspend(this.spec.activeAccountId());
  }

  /**
   * Apply a new inactivity threshold from Settings.
   *
   * Pending teardowns are re-armed against the new value so a change takes effect on the
   * accounts already waiting, rather than only on the next switch. Choosing "Never" cancels
   * them outright; shortening the delay can suspend an already-stale account on the spot.
   */
  public setSuspendDelayMinutes(minutes: number): void {
    if (!Number.isFinite(minutes) || minutes < 0) return;
    this.suspendDelayMinutes = minutes;

    const pending = [...this.suspendTimers.keys()];
    for (const accountId of pending) {
      this.cancelSuspend(accountId);
    }
    if (minutes === SUSPEND_NEVER) return;
    for (const accountId of pending) {
      this.scheduleSuspend(accountId);
    }
  }

  /** Tear down every account view that isn't needed right now. Used on quit. */
  public suspendAllAccounts(): void {
    for (const accountId of [...this.views.keys()]) {
      this.cancelSuspend(accountId);
      this.suspendAccount(accountId, true);
    }
  }

  /**
   * Arm the teardown of an account that just stopped being on screen.
   *
   * Nothing is destroyed yet — a user flicking between accounts would pay a reload every
   * time. Reactivating the account before the timer fires cancels it, so only accounts left
   * alone for the configured number of minutes are released.
   */
  private scheduleSuspend(accountId: string): void {
    if (!this.views.has(accountId)) return;
    if (this.suspendDelayMinutes === SUSPEND_NEVER) return;

    const existing = this.suspendTimers.get(accountId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(
      () => {
        this.suspendTimers.delete(accountId);
        this.suspendAccount(accountId);
      },
      this.suspendDelayMinutes * 60 * 1000,
    );
    // Never hold the event loop open just to tear a view down.
    timer.unref?.();
    this.suspendTimers.set(accountId, timer);
  }

  private cancelSuspend(accountId: string): void {
    const timer = this.suspendTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.suspendTimers.delete(accountId);
    }
  }

  /**
   * Destroy an inactive account's renderer, remembering where it was.
   *
   * Destruction is the only thing that actually returns the memory: detaching the view,
   * throttling it, freezing it via CDP, purging its V8 heap and even navigating it to
   * about:blank all measured at 0MB reclaimed, because the renderer process keeps its pages.
   * Closing the webContents releases the lot.
   */
  private suspendAccount(accountId: string, force = false): void {
    // Guard against a timer firing just after a switch back to this account. Teardown passes
    // force, since on quit even the visible account must go.
    if (!force && accountId === this.spec.activeAccountId() && this.windowVisible) return;

    const view = this.views.get(accountId);
    if (!view) return;

    this.log.info(`Suspending inactive view for account ${accountId} (force=${force})`);
    if (viewIsAlive(view)) {
      const remembered = this.spec.rememberUrl(view.webContents.getURL());
      if (remembered) this.suspendedUrls.set(accountId, remembered);
    }

    this.spec.detach(accountId, view);
    this.views.delete(accountId);
    this.loadedAccounts.delete(accountId);
    this.spec.onRelease(accountId, view);

    if (viewIsAlive(view)) view.webContents.close();
  }

  /** What was remembered for an account, consumed: the next view it builds starts there. */
  private takeSuspendedUrl(accountId: string): string | undefined {
    const url = this.suspendedUrls.get(accountId);
    this.suspendedUrls.delete(accountId);
    return url;
  }

  // MARK: - Background actions

  /**
   * The renderer an action needs, waking a suspended account behind it.
   *
   * A suspended account has no view at all — `suspendAccount` closes its webContents — so this
   * builds a fresh one, which has loaded no URL. Driving that view finds an empty document and
   * the action is lost without a word, which is the state a window hidden for the configured
   * number of minutes leaves even the account on screen in. The view is pointed back at what
   * the account was looking at (or the app's sign-in page) and its page awaited before the
   * caller is handed it.
   *
   * The view is also attached for the length of the action, through `attachForAction`: an
   * account the user is not looking at has no parent to lay out in, and a page renders no
   * control the action can find in a viewport of zero.
   *
   * The returned `release` must be called when the action is done, and puts the view back the
   * way it was. `undefined` means the account is unknown or its page never became ready, and
   * the action cannot run.
   */
  public async wakeForAction(
    accountId: string,
    options: WakeForActionOptions<View>,
  ): Promise<{ view: View; release: () => void } | undefined> {
    const wasLoaded = this.isAccountLoaded(accountId);
    const view = this.ensureView(accountId);
    if (!viewIsAlive(view)) {
      this.log.warn(`No view available for ${accountId}; the action cannot run`);
      return undefined;
    }

    if (!wasLoaded) {
      this.loadedAccounts.add(accountId);
      view.webContents.loadURL(this.takeSuspendedUrl(accountId) ?? options.loginUrl);
    }

    const detach = options.attachForAction(view);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      detach();
      this.releaseWokenView(accountId, wasLoaded);
    };

    // Only when the account was woken: an action that navigates or reloads anyway does not
    // need the page it is replacing to finish first.
    if (!wasLoaded) {
      if (options.waitForLoad && !(await options.waitForLoad(view))) {
        this.log.warn(
          `The account did not finish loading for ${accountId}; the action cannot proceed`,
        );
        release();
        return undefined;
      }
    } else if (options.waitForReady) {
      await options.waitForReady(view);
    }

    return { view, release };
  }

  /**
   * Let an account woken purely to service a background action go back to sleep.
   *
   * Never the account on screen in a visible window: the user is looking at that one, and its
   * lifetime belongs to the normal switch and window-visibility rules. While the window is
   * hidden the account on screen is suspended like any other, so a view woken then has to
   * return to the timer rather than stay alive because it happens to be the active one.
   */
  private releaseWokenView(accountId: string, wasLoaded: boolean): void {
    if (wasLoaded) return;
    if (accountId === this.spec.activeAccountId() && this.windowVisible) return;
    this.scheduleSuspend(accountId);
  }

  // MARK: - Diagnostics

  /**
   * The children of the window's contentView, named by the account each belongs to.
   *
   * A view's parent is the whole reason a background action attaches one — a view with no
   * parent lays out at nothing — so the attach and detach lines report what is on the window,
   * and a second account view left on it is visible in the log.
   */
  public attachedSummary(): string {
    const children = this.spec.window().contentView?.children ?? [];
    const accounts = children.map((child) => {
      for (const [id, view] of this.views) {
        if (view === child) return id;
      }
      return 'non-account';
    });
    return `attached: ${children.length}, accounts: [${accounts.join(', ')}]`;
  }
}
