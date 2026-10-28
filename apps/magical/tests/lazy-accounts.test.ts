/**
 * Lazy creation and suspension of account WebContentsViews in Magical.
 *
 * The invariants under test are memory invariants: an account that is not on
 * screen must not own a renderer for longer than the grace period, and an
 * account that has never been opened must not own one at all. Everything here
 * asserts on view construction, `webContents.close()`, and navigation, because
 * those are the only observable proxies for the renderer processes that were
 * measured at ~250–350MB each.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BaseWindow } from 'electron';
import { configureGoogleSession } from '@magimail/core';
import { AccountsManager, SUSPEND_NEVER } from '../src/accounts-manager.js';
import { loadSettings, saveSetting } from '../src/settings-store.js';

/** The default `inactiveAccountSuspendMinutes`, in milliseconds. */
const DEFAULT_SUSPEND_DELAY_MS = 5 * 60 * 1000;

const TEST_USER_DATA = vi.hoisted(() => `/tmp/magical-lazy-test-${process.pid}-${Date.now()}`);

/** Every view the manager has constructed, in order, with its mock webContents. */
const constructedViews = vi.hoisted(() => [] as MockView[]);

interface MockWebContents {
  loadURL: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setBackgroundThrottling: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn>;
  getTitle: ReturnType<typeof vi.fn>;
  partition: string;
  /** The handlers passed to `on`, so a test can drive a navigation event. */
  handlers: Map<string, (...args: unknown[]) => void>;
}
interface MockView {
  webContents: MockWebContents;
}

vi.mock('@magimail/core', async () => {
  const actual = await vi.importActual<typeof import('@magimail/core')>('@magimail/core');
  return { ...actual, configureGoogleSession: vi.fn() };
});

vi.mock('electron', () => {
  class MockWebContentsView {
    webContents: MockWebContents;
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();
    setVisible = vi.fn();

    constructor(opts?: { webPreferences?: { partition?: string } }) {
      let destroyed = false;
      const handlers = new Map<string, (...args: unknown[]) => void>();
      this.webContents = {
        partition: opts?.webPreferences?.partition ?? '',
        loadURL: vi.fn(),
        close: vi.fn(() => {
          destroyed = true;
        }),
        setBackgroundThrottling: vi.fn(),
        isDestroyed: vi.fn(() => destroyed),
        getURL: vi.fn().mockReturnValue('https://calendar.google.com/calendar/r'),
        getTitle: vi.fn().mockReturnValue('Calendar'),
        handlers,
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, handler);
        }),
        once: vi.fn(),
        off: vi.fn(),
        isLoading: vi.fn().mockReturnValue(false),
        insertCSS: vi.fn().mockResolvedValue(''),
        removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
        setWindowOpenHandler: vi.fn(),
        executeJavaScript: vi.fn().mockResolvedValue(false),
        sendInputEvent: vi.fn(),
        focus: vi.fn(),
        canGoBack: vi.fn().mockReturnValue(true),
        goBack: vi.fn(),
        canGoForward: vi.fn().mockReturnValue(true),
        goForward: vi.fn(),
      } as unknown as MockWebContents;
      constructedViews.push(this as unknown as MockView);
    }
  }

  const children: unknown[] = [];
  const windowHandlers = new Map<string, () => void>();

  class MockBaseWindow {
    static __handlers = windowHandlers;
    contentView = {
      children,
      addChildView: vi.fn((v: unknown, index?: number) => {
        if (typeof index === 'number') {
          children.splice(index, 0, v);
        } else {
          children.push(v);
        }
      }),
      removeChildView: vi.fn((v: unknown) => {
        const i = children.indexOf(v);
        if (i >= 0) children.splice(i, 1);
      }),
    };
    show = vi.fn();
    focus = vi.fn();
    setBackgroundColor = vi.fn();
    getContentSize = vi.fn().mockReturnValue([1200, 800]);
    getNativeWindowHandle = vi.fn().mockReturnValue(Buffer.alloc(8));
    isDestroyed = vi.fn().mockReturnValue(false);
    on = vi.fn((event: string, cb: () => void) => {
      windowHandlers.set(event, cb);
    });
  }

  return {
    BaseWindow: MockBaseWindow,
    WebContentsView: MockWebContentsView,
    session: {
      fromPartition: vi.fn().mockReturnValue({
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn(), onBeforeRequest: vi.fn() },
        clearStorageData: vi.fn().mockResolvedValue(undefined),
        clearCache: vi.fn().mockResolvedValue(undefined),
      }),
      defaultSession: {
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn(), onBeforeRequest: vi.fn() },
      },
    },
    app: { getPath: vi.fn().mockReturnValue(TEST_USER_DATA) },
    shell: { openExternal: vi.fn() },
    ipcMain: { on: vi.fn() },
  };
});

const ACCOUNT_A = 'account_a';
const ACCOUNT_B = 'account_b';

function seedTwoAccounts(): void {
  fs.mkdirSync(TEST_USER_DATA, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_USER_DATA, 'accounts.json'),
    JSON.stringify([
      {
        id: ACCOUNT_A,
        name: 'Personal',
        partition: 'persist:magical_personal',
        color: '#a855f7',
      },
      {
        id: ACCOUNT_B,
        name: 'Work',
        partition: 'persist:magical_work',
        color: '#3b82f6',
      },
    ]),
  );
}

/** The view the manager built for a partition, or undefined if it never built one. */
function viewFor(partition: string): MockView | undefined {
  return constructedViews.find((v) => v.webContents.partition === partition);
}

/** Fire a window event the manager subscribed to. */
function emitWindowEvent(event: 'hide' | 'show'): void {
  (BaseWindow as unknown as { __handlers: Map<string, () => void> }).__handlers.get(event)?.();
}

describe('lazy account views in Magical', () => {
  let manager: AccountsManager;
  let win: InstanceType<typeof BaseWindow>;

  afterAll(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    constructedViews.length = 0;
    vi.mocked(configureGoogleSession).mockClear();
    seedTwoAccounts();
    // Every test starts from "nothing remembered", so one test's choice is not the
    // next one's cold-start answer.
    saveSetting('lastActiveAccountId', '');
    win = new BaseWindow();
    win.contentView.children.length = 0;
    manager = new AccountsManager(win, '/preload.js');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a view only for the account shown at launch', () => {
    expect(constructedViews).toHaveLength(1);
    expect(constructedViews[0].webContents.partition).toBe('persist:magical_personal');
    expect(viewFor('persist:magical_work')).toBeUndefined();
    expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(false);
  });

  it('configures the partition of every account, including unopened ones', () => {
    const partitions = vi.mocked(configureGoogleSession).mock.calls.map(([partition]) => partition);

    expect(partitions).toContain('persist:magical_personal');
    expect(partitions).toContain('persist:magical_work');
    expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(false);
  });

  it('navigates only the launched account, leaving the rest unloaded', () => {
    expect(viewFor('persist:magical_personal')!.webContents.loadURL).toHaveBeenCalledWith(
      expect.stringContaining('calendar.google.com'),
    );
    expect(constructedViews).toHaveLength(1);
  });

  it('builds and navigates the second account on first switch', () => {
    manager.switchAccount(ACCOUNT_B);

    const viewB = viewFor('persist:magical_work');
    expect(viewB).toBeDefined();
    expect(viewB!.webContents.loadURL).toHaveBeenCalledWith(
      expect.stringContaining('calendar.google.com'),
    );
    expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(true);
  });

  it('keeps a just-abandoned account alive so rapid switching costs no reload', () => {
    manager.switchAccount(ACCOUNT_B);

    expect(viewFor('persist:magical_personal')!.webContents.close).not.toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
  });

  it('destroys an account left inactive for the grace period', () => {
    manager.switchAccount(ACCOUNT_B);
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

    expect(viewFor('persist:magical_personal')!.webContents.close).toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
    // The active account is untouched.
    expect(viewFor('persist:magical_work')!.webContents.close).not.toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(true);
  });

  it('cancels a pending suspend when the account is switched back to', () => {
    manager.switchAccount(ACCOUNT_B);
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS / 2);
    manager.switchAccount(ACCOUNT_A);
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

    expect(viewFor('persist:magical_personal')!.webContents.close).not.toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
  });

  it('returns a resumed account to where it was (exact date and view mode), not default URL', () => {
    const calendarMonthUrl = 'https://calendar.google.com/calendar/r/month/2026/9/1';
    viewFor('persist:magical_personal')!.webContents.getURL.mockReturnValue(calendarMonthUrl);

    manager.switchAccount(ACCOUNT_B);
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
    manager.switchAccount(ACCOUNT_A);

    const resumed = constructedViews
      .filter((v) => v.webContents.partition === 'persist:magical_personal')
      .at(-1)!;
    expect(resumed.webContents.loadURL).toHaveBeenCalledWith(calendarMonthUrl);
  });

  it("resumes on a URL Google Calendar's offline cache can answer", () => {
    // That cache matches the exact URL, so a stored `?pli=1` is the difference between
    // a view that comes back showing the calendar with no network and one that fails
    // to load at all. The path, which is where the date and the view mode live, stays.
    viewFor('persist:magical_personal')!.webContents.getURL.mockReturnValue(
      'https://calendar.google.com/calendar/u/0/r/month/2026/9/1?pli=1',
    );

    manager.switchAccount(ACCOUNT_B);
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
    manager.switchAccount(ACCOUNT_A);

    const resumed = constructedViews
      .filter((v) => v.webContents.partition === 'persist:magical_personal')
      .at(-1)!;
    expect(resumed.webContents.loadURL).toHaveBeenCalledWith(
      'https://calendar.google.com/calendar/u/0/r/month/2026/9/1',
    );
  });

  it('does not toggle background throttling when accounts switch', () => {
    manager.switchAccount(ACCOUNT_B);

    expect(
      viewFor('persist:magical_personal')!.webContents.setBackgroundThrottling,
    ).not.toHaveBeenCalled();
    expect(
      viewFor('persist:magical_work')!.webContents.setBackgroundThrottling,
    ).not.toHaveBeenCalled();
  });

  it('ages out the visible account too once the window is hidden', () => {
    emitWindowEvent('hide');
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

    expect(viewFor('persist:magical_personal')!.webContents.close).toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
  });

  it('ages out the visible account of a window built hidden for a background action', () => {
    // A window created hidden fires no `hide`, so nothing else arms the teardown.
    manager.handleWindowHidden();
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

    expect(viewFor('persist:magical_personal')!.webContents.close).toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
  });

  it('never ages it out when the threshold is Never, even built hidden', () => {
    manager.setSuspendDelayMinutes(SUSPEND_NEVER);
    manager.handleWindowHidden();
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS * 10);

    expect(viewFor('persist:magical_personal')!.webContents.close).not.toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
  });

  it('restores the unloaded account when the window is shown with no other request', async () => {
    emitWindowEvent('hide');
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
    emitWindowEvent('show');
    await Promise.resolve();

    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
  });

  it('does not resurrect the outgoing account when switching to a different one on show', async () => {
    emitWindowEvent('hide');
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
    const viewsAfterUnload = constructedViews.length;

    emitWindowEvent('show');
    manager.switchAccount(ACCOUNT_B);
    await Promise.resolve();

    expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(true);
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
    expect(constructedViews).toHaveLength(viewsAfterUnload + 1);
  });

  it('keeps the visible account when the window is shown again in time', () => {
    emitWindowEvent('hide');
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS / 2);
    emitWindowEvent('show');
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

    expect(viewFor('persist:magical_personal')!.webContents.close).not.toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
  });

  it('releases every account view on teardown', () => {
    manager.switchAccount(ACCOUNT_B);
    manager.suspendAllAccounts();

    expect(viewFor('persist:magical_personal')!.webContents.close).toHaveBeenCalled();
    expect(viewFor('persist:magical_work')!.webContents.close).toHaveBeenCalled();
  });

  describe('configurable inactivity threshold', () => {
    it('honours a longer threshold chosen before switching away', () => {
      manager.setSuspendDelayMinutes(30);
      manager.switchAccount(ACCOUNT_B);

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      expect(viewFor('persist:magical_personal')!.webContents.close).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(viewFor('persist:magical_personal')!.webContents.close).toHaveBeenCalled();
    });

    it('never unloads when set to Never', () => {
      manager.setSuspendDelayMinutes(SUSPEND_NEVER);
      manager.switchAccount(ACCOUNT_B);
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);

      expect(viewFor('persist:magical_personal')!.webContents.close).not.toHaveBeenCalled();
      expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
    });

    it('cancels an account already waiting when switched to Never', () => {
      manager.switchAccount(ACCOUNT_B);
      manager.setSuspendDelayMinutes(SUSPEND_NEVER);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS * 10);

      expect(viewFor('persist:magical_personal')!.webContents.close).not.toHaveBeenCalled();
    });

    it('re-arms an account already waiting when the threshold is shortened', () => {
      manager.switchAccount(ACCOUNT_B);
      manager.setSuspendDelayMinutes(1);
      vi.advanceTimersByTime(60 * 1000);

      expect(viewFor('persist:magical_personal')!.webContents.close).toHaveBeenCalled();
    });

    it('ignores a nonsensical threshold rather than disabling suspension', () => {
      manager.setSuspendDelayMinutes(-5);
      manager.switchAccount(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      expect(viewFor('persist:magical_personal')!.webContents.close).toHaveBeenCalled();
    });
  });

  describe('waking suspended accounts for event actions', () => {
    it('wakes a suspended account on revealEvent and navigates to Calendar login URL', async () => {
      expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(false);

      const revealPromise = manager.revealEvent(ACCOUNT_B, 'EID_123', new Date(2026, 8, 17));

      const viewB = viewFor('persist:magical_work');
      expect(viewB).toBeDefined();

      // The script that pushes state is the one that waits for Calendar to stop
      // redrawing, so what it resolves with is whether the route arrived.
      let livePath = '/calendar/r';
      viewB!.webContents.getURL.mockImplementation(() => `https://calendar.google.com${livePath}`);

      vi.mocked(viewB!.webContents.executeJavaScript).mockImplementation((script: string) => {
        if (script.includes('eventedit')) return Promise.resolve(false);
        if (script.includes('data-viewkey')) return Promise.resolve(null);
        if (script.includes('pushState')) {
          const pushed = /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(script)?.[1];
          if (pushed) livePath = pushed;
          return Promise.resolve(true);
        }
        return Promise.resolve(true);
      });

      // Waking the view runs on timers this suite has faked.
      await vi.advanceTimersByTimeAsync(6000);

      const outcome = await revealPromise;
      expect(outcome).toBe('revealed');
      expect(viewB!.webContents.loadURL).toHaveBeenCalledWith(
        'https://accounts.google.com/ServiceLogin?service=cl&continue=https://calendar.google.com/calendar/r',
      );
    });

    it('wakes a suspended account on performRsvp and schedules suspension after action', async () => {
      expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(false);

      const rsvpPromise = manager.performRsvp(ACCOUNT_B, 'EID_123', 'yes', new Date(2026, 8, 17));
      // The direct write is tried first and declines before the view is woken, so the
      // wake lands a microtask after the call rather than synchronously.
      await Promise.resolve();

      const viewB = viewFor('persist:magical_work');
      expect(viewB).toBeDefined();

      vi.mocked(viewB!.webContents.executeJavaScript).mockImplementation((script: string) => {
        if (script.includes('location.pathname + location.search')) {
          return Promise.resolve('/calendar/u/0/r/week/2026/9/14');
        }
        if (script.includes('eventedit')) return Promise.resolve(false);
        if (script.includes('getBoundingClientRect')) {
          return Promise.resolve({ x: 100, y: 100, width: 50, height: 30 });
        }
        return Promise.resolve(true);
      });

      const outcome = await rsvpPromise;
      expect(outcome).toBe('ok');
      expect(viewB!.webContents.loadURL).toHaveBeenCalledWith(
        'https://accounts.google.com/ServiceLogin?service=cl&continue=https://calendar.google.com/calendar/r',
      );

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      expect(viewB!.webContents.close).toHaveBeenCalled();
      expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(false);
    });

    it('re-suspends the account on screen when an event action wakes it while the window is hidden', async () => {
      // The account on screen is normally exempt from suspension. While the window is
      // hidden it is not, and an action that wakes it must hand its renderer back to
      // the timer rather than leave it awake because it happens to be the active one.
      emitWindowEvent('hide');
      manager.setSuspendDelayMinutes(1);
      manager.suspendAllAccounts();
      expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);

      const rsvpPromise = manager.performRsvp(ACCOUNT_A, 'EID_123', 'yes', new Date(2026, 8, 17));
      // The direct write is tried first and declines before the view is woken.
      await Promise.resolve();
      // The original view was closed on suspend, so the wake built a second one.
      const viewA = constructedViews
        .filter((v) => v.webContents.partition === 'persist:magical_personal')
        .at(-1)!;
      vi.mocked(viewA.webContents.executeJavaScript).mockImplementation((script: string) => {
        if (script.includes('location.pathname + location.search')) {
          return Promise.resolve('/calendar/u/0/r/week/2026/9/14');
        }
        if (script.includes('eventedit')) return Promise.resolve(false);
        if (script.includes('getBoundingClientRect')) {
          return Promise.resolve({ x: 100, y: 100, width: 50, height: 30 });
        }
        return Promise.resolve(true);
      });

      expect(await rsvpPromise).toBe('ok');
      expect(viewA.webContents.loadURL).toHaveBeenCalled();

      vi.advanceTimersByTime(60 * 1000);
      expect(viewA.webContents.close).toHaveBeenCalled();
      expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });

    it('re-suspends the account on screen when the window was built in the background', async () => {
      // Never shown, so the account on screen is not exempt from suspension.
      manager.setSuspendDelayMinutes(1);
      manager.suspendAllAccounts();
      expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);

      const rsvpPromise = manager.performRsvp(ACCOUNT_A, 'EID_123', 'yes', new Date(2026, 8, 17));
      await Promise.resolve();
      const viewA = constructedViews
        .filter((v) => v.webContents.partition === 'persist:magical_personal')
        .at(-1)!;
      vi.mocked(viewA.webContents.executeJavaScript).mockImplementation((script: string) => {
        if (script.includes('location.pathname + location.search')) {
          return Promise.resolve('/calendar/u/0/r/week/2026/9/14');
        }
        if (script.includes('eventedit')) return Promise.resolve(false);
        if (script.includes('getBoundingClientRect')) {
          return Promise.resolve({ x: 100, y: 100, width: 50, height: 30 });
        }
        return Promise.resolve(true);
      });

      expect(await rsvpPromise).toBe('ok');

      vi.advanceTimersByTime(60 * 1000);
      expect(viewA.webContents.close).toHaveBeenCalled();
      expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });

    it('re-suspends the account on screen when the toolbar wakes it while the window is hidden', async () => {
      // The toolbar action shares `wakeAccountForAction` with the event actions; the
      // release that puts the view back is the same one, so the guard has to let the
      // account on screen go to sleep while the window is hidden here too.
      emitWindowEvent('hide');
      manager.setSuspendDelayMinutes(1);
      manager.suspendAllAccounts();
      expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);

      await manager.triggerCalendarAction('navToday');

      const viewA = constructedViews
        .filter((v) => v.webContents.partition === 'persist:magical_personal')
        .at(-1)!;
      expect(viewA.webContents.loadURL).toHaveBeenCalled();

      vi.advanceTimersByTime(60 * 1000);
      expect(viewA.webContents.close).toHaveBeenCalled();
      expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
    });
  });

  describe('removing an account', () => {
    it('announces the removal before the account record is dropped', () => {
      const seen: { accountId: string; stillConfigured: boolean }[] = [];
      manager.onAccountRemoving = (accountId) => {
        seen.push({
          accountId,
          stillConfigured: manager.getAccounts().some((a) => a.id === accountId),
        });
      };

      expect(manager.removeAccount(ACCOUNT_B)).toBe(true);

      // The caches keyed by the id are purged from this callback, so it has to run while
      // the account is still the one being removed rather than one already gone.
      expect(seen).toEqual([{ accountId: ACCOUNT_B, stillConfigured: true }]);
      expect(manager.getAccounts().map((a) => a.id)).toEqual([ACCOUNT_A]);
    });
  });

  describe('reordering accounts', () => {
    it('updates the order and triggers onAccountsChanged', () => {
      const changed = vi.fn();
      manager.onAccountsChanged = changed;

      manager.reorderAccounts([ACCOUNT_B, ACCOUNT_A]);
      expect(manager.getAccounts().map((a) => a.id)).toEqual([ACCOUNT_B, ACCOUNT_A]);
      expect(changed).toHaveBeenCalledTimes(1);
    });

    it('ignores an incomplete or invalid list of accounts', () => {
      const changed = vi.fn();
      manager.onAccountsChanged = changed;

      manager.reorderAccounts([ACCOUNT_B]);
      expect(manager.getAccounts().map((a) => a.id)).toEqual([ACCOUNT_A, ACCOUNT_B]);
      expect(changed).not.toHaveBeenCalled();

      manager.reorderAccounts(['unknown_1', 'unknown_2']);
      expect(manager.getAccounts().map((a) => a.id)).toEqual([ACCOUNT_A, ACCOUNT_B]);
      expect(changed).not.toHaveBeenCalled();
    });
  });

  describe('history navigation', () => {
    it('navigates history back and forward for active view', () => {
      const view = manager.getActiveView();
      expect(view).toBeDefined();

      (view!.webContents.canGoBack as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
      expect(manager.canGoBack()).toBe(true);
      expect(manager.goBack()).toBe(true);
      expect(view!.webContents.goBack).toHaveBeenCalledTimes(1);

      (view!.webContents.canGoBack as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
      expect(manager.canGoBack()).toBe(false);
      expect(manager.goBack()).toBe(false);

      (view!.webContents.canGoForward as unknown as ReturnType<typeof vi.fn>).mockReturnValue(true);
      expect(manager.canGoForward()).toBe(true);
      expect(manager.goForward()).toBe(true);
      expect(view!.webContents.goForward).toHaveBeenCalledTimes(1);

      (view!.webContents.canGoForward as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        false,
      );
      expect(manager.canGoForward()).toBe(false);
      expect(manager.goForward()).toBe(false);
    });

    it('reports a navigation in the active view so the menu can follow it', () => {
      const onHistoryChanged = vi.fn();
      manager.onHistoryChanged = onHistoryChanged;

      const view = manager.getActiveView();
      expect(view).toBeDefined();

      view!.webContents.handlers.get('did-navigate-in-page')?.({}, 'https://calendar.google.com/');
      expect(onHistoryChanged).toHaveBeenCalledTimes(1);
    });
  });

  describe('account view attachment', () => {
    it('keeps only the account on screen attached while switching', () => {
      manager.switchAccount(ACCOUNT_B);

      let maxViewsAttached = 0;
      const origAdd = win.contentView.addChildView;
      win.contentView.addChildView = vi.fn((v: unknown) => {
        origAdd(v);
        maxViewsAttached = Math.max(maxViewsAttached, win.contentView.children.length);
      });

      // ACCOUNT_A precedes ACCOUNT_B in the views map, so the switch visits it first
      manager.switchAccount(ACCOUNT_A);

      expect(maxViewsAttached).toBe(1);
      expect(win.contentView.children).toHaveLength(1);
      expect(viewFor('persist:magical_personal')!.setVisible).toHaveBeenCalledWith(true);
    });

    it('hides a view attached for a background action', () => {
      manager.switchAccount(ACCOUNT_B);
      manager.switchAccount(ACCOUNT_A);
      const viewB = viewFor('persist:magical_work')!;

      const restore = (
        manager as unknown as {
          attachForBackgroundAction: (v: unknown, id: string) => () => void;
        }
      ).attachForBackgroundAction(viewB, ACCOUNT_B);

      expect(viewB.setVisible).toHaveBeenCalledWith(false);
      expect(win.contentView.children[0]).toBe(viewB);

      restore();
      expect(viewB.setVisible).toHaveBeenCalledWith(true);
      expect(win.contentView.children).not.toContain(viewB);
    });

    it('shows a background-action view once it becomes the account on screen', () => {
      manager.switchAccount(ACCOUNT_B);
      manager.switchAccount(ACCOUNT_A);
      const viewB = viewFor('persist:magical_work')!;

      const restore = (
        manager as unknown as {
          attachForBackgroundAction: (v: unknown, id: string) => () => void;
        }
      ).attachForBackgroundAction(viewB, ACCOUNT_B);

      expect(viewB.setVisible).toHaveBeenCalledWith(false);

      manager.switchAccount(ACCOUNT_B);
      expect(viewB.setVisible).toHaveBeenCalledWith(true);

      restore();
      expect(viewB.setVisible).toHaveBeenCalledWith(true);
      expect(win.contentView.children).toContain(viewB);
    });
  });

  // Cold launch: a cold launch from a widget or notification opens on the account the link
  // named. What makes that visible is which view is built: the manager builds exactly
  // one at construction, so the account it belongs to is the account the launch chose.
  describe('cold start account selection', () => {
    afterEach(() => {
      saveSetting('lastActiveAccountId', '');
    });

    it('builds the launch-linked account, not the first in the list', () => {
      constructedViews.length = 0;
      const linked = new AccountsManager(new BaseWindow(), '/preload.js', {
        initialAccountId: ACCOUNT_B,
      });

      expect(linked.getActiveAccountId()).toBe(ACCOUNT_B);
      expect(constructedViews).toHaveLength(1);
      expect(constructedViews[0].webContents.partition).toBe('persist:magical_work');
      expect(viewFor('persist:magical_personal')).toBeUndefined();
    });

    it('restores the last active account when no link names one', () => {
      saveSetting('lastActiveAccountId', ACCOUNT_B);
      constructedViews.length = 0;

      const restored = new AccountsManager(new BaseWindow(), '/preload.js');

      expect(restored.getActiveAccountId()).toBe(ACCOUNT_B);
      expect(constructedViews).toHaveLength(1);
      expect(constructedViews[0].webContents.partition).toBe('persist:magical_work');
    });

    it('falls back to the first account when the link names one that is gone', () => {
      constructedViews.length = 0;
      const linked = new AccountsManager(new BaseWindow(), '/preload.js', {
        initialAccountId: 'account_removed',
      });

      expect(linked.getActiveAccountId()).toBe(ACCOUNT_A);
      expect(constructedViews).toHaveLength(1);
      expect(constructedViews[0].webContents.partition).toBe('persist:magical_personal');
    });

    it('records the account on screen on the way out', () => {
      manager.switchAccount(ACCOUNT_B);
      manager.persistActiveAccount();

      expect(loadSettings().lastActiveAccountId).toBe(ACCOUNT_B);
    });
  });

  // Closing the main window while syncCalendarMetadata is awaiting its DOM read
  // must not write to disk or invoke change callbacks once the window or view has gone.
  describe('in-flight calendar metadata sync across window close', () => {
    it('cancels metadata sync if window is destroyed before scrape', async () => {
      vi.mocked(win.isDestroyed).mockReturnValue(true);
      const changed = vi.fn();
      manager.onAccountsChanged = changed;

      await manager.syncCalendarMetadata(ACCOUNT_A);

      expect(changed).not.toHaveBeenCalled();
    });

    it('cancels metadata sync if window is destroyed while fetchCalendars is in flight', async () => {
      const view = viewFor('persist:magical_personal')!;
      let resolveScrape!: (val: unknown) => void;
      vi.mocked(view.webContents.executeJavaScript).mockReturnValue(
        new Promise((resolve) => {
          resolveScrape = resolve;
        }),
      );

      const changed = vi.fn();
      manager.onAccountsChanged = changed;

      const syncPromise = manager.syncCalendarMetadata(ACCOUNT_A);

      // Window is closed while scrape is in flight
      vi.mocked(win.isDestroyed).mockReturnValue(true);

      resolveScrape([
        { id: 'cal-new@group.calendar.google.com', name: 'New Cal', color: '#123456' },
      ]);

      await syncPromise;

      expect(changed).not.toHaveBeenCalled();
    });

    it('cancels metadata sync if view is destroyed while fetchCalendars is in flight', async () => {
      const view = viewFor('persist:magical_personal')!;
      let resolveScrape!: (val: unknown) => void;
      vi.mocked(view.webContents.executeJavaScript).mockReturnValue(
        new Promise((resolve) => {
          resolveScrape = resolve;
        }),
      );

      const changed = vi.fn();
      manager.onAccountsChanged = changed;

      const syncPromise = manager.syncCalendarMetadata(ACCOUNT_A);

      // View's webContents is destroyed while scrape is in flight
      vi.mocked(view.webContents.isDestroyed).mockReturnValue(true);

      resolveScrape([
        { id: 'cal-new@group.calendar.google.com', name: 'New Cal', color: '#123456' },
      ]);

      await syncPromise;

      expect(changed).not.toHaveBeenCalled();
    });
  });
});
