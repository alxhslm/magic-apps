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
import { saveSetting } from '../src/settings-store.js';

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
});

/**
 * The view rebuild, which is the repair a reload request used to ask for.
 *
 * `Cmd+R` now rebuilds the window instead — twenty of these in twenty seconds on 29
 * October left the window blank — so this path serves the Settings toggles that change
 * Google's own layout and the wake-from-sleep handler.
 */
describe('rebuilding an account view', () => {
  let manager: AccountsManager;
  let win: InstanceType<typeof BaseWindow>;

  afterAll(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.useFakeTimers();
    constructedViews.length = 0;
    seedTwoAccounts();
    saveSetting('lastActiveAccountId', '');
    win = new BaseWindow();
    win.contentView.children.length = 0;
    manager = new AccountsManager(win, '/preload.js');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('rebuilds the view through the pool rather than an in-place webContents.reload()', () => {
    const initialView = constructedViews[0];

    manager.reloadActive();

    // The old view's WebContents was closed, and a fresh view was constructed.
    expect(initialView.webContents.close).toHaveBeenCalledTimes(1);
    expect(constructedViews).toHaveLength(2);
    expect(constructedViews[1].webContents.close).not.toHaveBeenCalled();
  });

  it('returns the replacement to the route the user was on', () => {
    constructedViews[0].webContents.getURL.mockReturnValue(
      'https://calendar.google.com/calendar/u/0/r/month/2026/11/15',
    );

    manager.reloadActive();

    expect(constructedViews[1].webContents.loadURL).toHaveBeenCalledWith(
      'https://calendar.google.com/calendar/u/0/r/month/2026/11/15',
    );
  });

  it('lays the replacement out', () => {
    manager.reloadActive();

    expect(constructedViews[1].setBounds).toHaveBeenCalled();
  });

  it('releases the views when the window has gone, without touching its contentView', () => {
    const initialView = constructedViews[0];
    // The state a suspend timer fires in five minutes after the window closed.
    (win as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;

    expect(() => manager.suspendAllAccounts()).not.toThrow();

    // The renderer is what costs memory, so it is closed even with no window to detach from.
    expect(initialView.webContents.close).toHaveBeenCalledTimes(1);
  });
});
