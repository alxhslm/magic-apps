import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BaseWindow, WebContentsView } from 'electron';
import { RendererPool, SUSPEND_NEVER } from '../src/renderer-pool.js';

/**
 * The ownership and timing rules the pool holds for both apps.
 *
 * These are memory invariants, not cosmetic ones: an account view is the largest thing either
 * app holds, so what matters is exactly when one is closed, what a released account remembers,
 * and which account the rules spare. Everything is asserted against a fake clock and a stand-in
 * view, because the real thing costs a renderer process per case.
 */

/** The default `inactiveAccountSuspendMinutes`, in milliseconds. */
const DEFAULT_SUSPEND_DELAY_MS = 5 * 60 * 1000;

const ACCOUNT_A = 'account_a';
const ACCOUNT_B = 'account_b';

interface FakeAccount {
  id: string;
}

const ACCOUNTS: FakeAccount[] = [{ id: ACCOUNT_A }, { id: ACCOUNT_B }];

/** A stand-in for a WebContentsView: what the pool asks of one, and nothing else. */
class FakeView {
  public closed = false;
  public throttled: boolean[] = [];
  public loaded: string[] = [];
  public url = 'https://example.test/inbox/1';
  public readonly webContents = {
    isDestroyed: () => this.closed,
    close: () => {
      this.closed = true;
      events.push(`close:${this.name}`);
    },
    getURL: () => this.url,
    loadURL: (url: string) => this.loaded.push(url),
    setBackgroundThrottling: (throttled: boolean) => this.throttled.push(throttled),
  };

  constructor(public readonly name: string) {}
}

/** The order things happened in, so "before the view closes" can be asserted rather than assumed. */
let events: string[] = [];
/** Every view the pool has built, in order. */
let created: FakeView[] = [];
/** The window's contentView children, which is what the pool attaches to. */
let children: unknown[] = [];
let activeId = ACCOUNT_A;
let pool: RendererPool<FakeAccount, WebContentsView>;

function viewOf(accountId: string): FakeView {
  return created.filter((view) => view.name === accountId).at(-1)!;
}

function makePool(
  options: {
    suspendDelayMinutes?: number;
    rememberUrl?: (url: string) => string | undefined;
  } = {},
): RendererPool<FakeAccount, WebContentsView> {
  return new RendererPool<FakeAccount, WebContentsView>(
    {
      window: () => ({ contentView: { children } }) as unknown as BaseWindow,
      accountFor: (accountId) => ACCOUNTS.find((account) => account.id === accountId),
      activeAccountId: () => activeId,
      createView: (account) => {
        const view = new FakeView(account.id);
        created.push(view);
        return view as unknown as WebContentsView;
      },
      attach: (_accountId, view) => {
        if (!children.includes(view)) children.push(view);
      },
      detach: (_accountId, view) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      },
      onRelease: (accountId) => {
        events.push(`release:${accountId}`);
      },
      rememberUrl: options.rememberUrl ?? ((url) => url),
    },
    { suspendDelayMinutes: options.suspendDelayMinutes ?? DEFAULT_SUSPEND_DELAY_MS / 60_000 },
  );
}

/** Puts an account on screen, as an app's switch does: the pool is told who is active as well. */
function show(accountId: string): WebContentsView | undefined {
  activeId = accountId;
  return pool.attachOnly(accountId);
}

describe('RendererPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    created = [];
    children = [];
    activeId = ACCOUNT_A;
    pool = makePool();
    // The window is on screen, which is the state every app's `show` event puts the pool in.
    pool.handleWindowShown();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('view ownership', () => {
    it('builds a view only when an account is put on screen', () => {
      expect(created).toHaveLength(0);

      show(ACCOUNT_A);

      expect(created).toHaveLength(1);
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(true);
      expect(pool.isAccountLoaded(ACCOUNT_B)).toBe(false);
      expect(created).toHaveLength(1);
    });

    it('builds no view for an account that is not configured', () => {
      expect(pool.attachOnly('account_removed')).toBeUndefined();
      expect(created).toHaveLength(0);
    });

    it('keeps one view attached at a time', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);

      expect(children).toHaveLength(1);
      expect(children[0]).toBe(viewOf(ACCOUNT_B));
      // The account that left the screen is throttled; the one on it is not.
      expect(viewOf(ACCOUNT_A).throttled.at(-1)).toBe(true);
      expect(viewOf(ACCOUNT_B).throttled.at(-1)).toBe(false);
    });

    it('reuses a live view rather than building a second one', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);
      show(ACCOUNT_A);

      expect(created).toHaveLength(2);
    });

    it("drops an account's view for good, remembering nothing", () => {
      show(ACCOUNT_A);
      const view = viewOf(ACCOUNT_A);
      view.url = 'https://example.test/inbox/thread/7';

      pool.removeView(ACCOUNT_A);

      expect(children).toHaveLength(0);
      expect(view.closed).toBe(true);
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
      // Nothing is remembered: an account that is gone has no page to return to.
      expect(pool.firstLoadUrl(ACCOUNT_A, 'https://example.test/signin')).toBe(
        'https://example.test/signin',
      );
    });

    it("drops an account's view but preserves its route when rememberUrl is requested", () => {
      show(ACCOUNT_A);
      const view = viewOf(ACCOUNT_A);
      view.url = 'https://example.test/inbox/thread/7';

      pool.removeView(ACCOUNT_A, { rememberUrl: true });

      expect(children).toHaveLength(0);
      expect(view.closed).toBe(true);
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
      // The route is remembered for firstLoadUrl
      expect(pool.firstLoadUrl(ACCOUNT_A, 'https://example.test/signin')).toBe(
        'https://example.test/inbox/thread/7',
      );
    });
  });

  describe('ageing out an account that left the screen', () => {
    it('releases nothing before the delay elapses', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS - 1);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(true);
      expect(viewOf(ACCOUNT_A).closed).toBe(false);
    });

    it('closes the view once the delay elapses, and only that one', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
      expect(viewOf(ACCOUNT_A).closed).toBe(true);
      expect(children).toHaveLength(1);
      expect(pool.isAccountLoaded(ACCOUNT_B)).toBe(true);
      expect(viewOf(ACCOUNT_B).closed).toBe(false);
    });

    it('cancels the pending release when the account is switched back to', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS / 2);

      show(ACCOUNT_A);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(true);
      expect(viewOf(ACCOUNT_A).closed).toBe(false);
    });

    it('releases what the app holds per view before the view closes', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      expect(events).toEqual([`release:${ACCOUNT_A}`, `close:${ACCOUNT_A}`]);
    });

    it('releases every view on teardown, the one on screen included', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);

      pool.suspendAllAccounts();

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
      expect(pool.isAccountLoaded(ACCOUNT_B)).toBe(false);
      expect(viewOf(ACCOUNT_A).closed).toBe(true);
      expect(viewOf(ACCOUNT_B).closed).toBe(true);
      expect(children).toHaveLength(0);
    });

    it('leaves no release armed behind a teardown', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);
      pool.suspendAllAccounts();
      events = [];

      // A second timer firing over a closed view would be a second close, and a second
      // release of surfaces the app has already let go of.
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS * 2);

      expect(events).toEqual([]);
    });
  });

  describe('the window being hidden', () => {
    it('lets the account on screen age out', () => {
      show(ACCOUNT_A);
      pool.handleWindowHidden();

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });

    it('spares the account on screen while the window is visible', () => {
      show(ACCOUNT_A);

      // Nothing is armed for an account the user is looking at.
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS * 10);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(true);
    });

    it('cancels the release when the window comes back in time', () => {
      show(ACCOUNT_A);
      pool.handleWindowHidden();
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS / 2);

      pool.handleWindowShown();
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(true);
      expect(pool.isWindowVisible()).toBe(true);
    });
  });

  describe('the configured inactivity threshold', () => {
    it('never arms a release when set to Never', () => {
      pool.setSuspendDelayMinutes(SUSPEND_NEVER);
      show(ACCOUNT_A);
      show(ACCOUNT_B);

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS * 10);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(true);
    });

    it('cancels an account already waiting when switched to Never', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);

      pool.setSuspendDelayMinutes(SUSPEND_NEVER);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS * 10);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(true);
    });

    it('re-arms an account already waiting when the threshold is shortened', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);

      pool.setSuspendDelayMinutes(1);
      vi.advanceTimersByTime(60_000);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });

    it('re-arms an account already waiting when the threshold is lengthened', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);

      pool.setSuspendDelayMinutes(30);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(true);
      vi.advanceTimersByTime(30 * 60_000);
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });

    it('ignores a nonsensical threshold rather than disabling suspension', () => {
      pool.setSuspendDelayMinutes(-5);
      show(ACCOUNT_A);
      show(ACCOUNT_B);

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });
  });

  describe('what a released account remembers', () => {
    it('restores the URL it was released on, through a view built for it', () => {
      show(ACCOUNT_A);
      viewOf(ACCOUNT_A).url = 'https://example.test/inbox/thread/42';
      show(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      const view = show(ACCOUNT_A);

      expect(created).toHaveLength(3);
      expect(view).toBe(viewOf(ACCOUNT_A));
      expect(pool.firstLoadUrl(ACCOUNT_A, 'https://example.test/signin')).toBe(
        'https://example.test/inbox/thread/42',
      );
    });

    it('remembers only once, so a view that already has a page costs no reload', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      show(ACCOUNT_A);

      expect(pool.firstLoadUrl(ACCOUNT_A, 'https://example.test/signin')).toBeDefined();
      expect(pool.firstLoadUrl(ACCOUNT_A, 'https://example.test/signin')).toBeUndefined();
    });

    it("falls back to the app's own page when the policy remembers nothing", () => {
      pool = makePool({ rememberUrl: () => undefined });
      pool.handleWindowShown();
      show(ACCOUNT_A);
      show(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      show(ACCOUNT_A);

      expect(pool.firstLoadUrl(ACCOUNT_A, 'https://example.test/signin')).toBe(
        'https://example.test/signin',
      );
    });

    it('drops what it remembered when the app asks it to', () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      show(ACCOUNT_A);

      pool.forgetSuspendedUrl(ACCOUNT_A);

      expect(pool.firstLoadUrl(ACCOUNT_A, 'https://example.test/signin')).toBe(
        'https://example.test/signin',
      );
    });
  });

  describe('waking an account for a background action', () => {
    /** Attaches the view for the action and returns the undo, as an app's own attach does. */
    function wake(accountId: string, waitForLoad?: (view: WebContentsView) => Promise<boolean>) {
      return pool.wakeForAction(accountId, {
        loginUrl: 'https://example.test/signin',
        attachForAction: (view) => {
          if (!children.includes(view)) children.push(view);
          return () => {
            const index = children.indexOf(view);
            if (index >= 0) children.splice(index, 1);
          };
        },
        waitForLoad,
      });
    }

    it('wakes a released account and points its new view at what it remembered', async () => {
      show(ACCOUNT_A);
      viewOf(ACCOUNT_A).url = 'https://example.test/inbox/thread/42';
      show(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);

      const woken = await wake(ACCOUNT_A);

      expect(woken).toBeDefined();
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(true);
      expect(viewOf(ACCOUNT_A).loaded).toEqual(['https://example.test/inbox/thread/42']);
      expect(children).toContain(woken!.view);
    });

    it('hands a woken account back to the timer when the action releases it', async () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      const woken = await wake(ACCOUNT_A);
      woken!.release();

      expect(children).not.toContain(woken!.view);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });

    it('leaves the release an account already waiting for alone', async () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS / 2);

      const woken = await wake(ACCOUNT_A);
      woken!.release();

      // The account was already counting down, and the action does not push that out.
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS / 2);
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });

    it('leaves the account on screen in a visible window alone', async () => {
      show(ACCOUNT_A);

      const woken = await wake(ACCOUNT_A);
      woken!.release();

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(true);
    });

    it('hands the account on screen back to the timer while the window is hidden', async () => {
      // The account on screen is normally exempt. While the window is hidden it is not, and a
      // view woken for an action must return to the timer rather than stay awake because it
      // happens to be the active one.
      show(ACCOUNT_A);
      pool.handleWindowHidden();
      pool.suspendAllAccounts();

      const woken = await wake(ACCOUNT_A);
      woken!.release();

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });

    it('cannot hand over a view whose page never arrived', async () => {
      show(ACCOUNT_A);
      show(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      const woken = await wake(ACCOUNT_A, () => Promise.resolve(false));

      expect(woken).toBeUndefined();
      expect(children).toHaveLength(1);
      // The account was woken for an action that could not run, so it goes back to the timer.
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      expect(pool.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });

    it('has no view to hand over for an account that is not configured', async () => {
      expect(await wake('account_removed')).toBeUndefined();
    });
  });
});
