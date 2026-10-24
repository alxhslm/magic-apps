/**
 * Lazy creation and suspension of account WebContentsViews.
 *
 * The invariants under test are memory invariants: an account that is not on
 * screen must not own a renderer for longer than the grace period, and an
 * account that has never been opened must not own one at all. Everything here
 * asserts on view construction, `webContents.close()`, and navigation, because
 * those are the only observable proxies for the renderer processes that were
 * measured at ~450MB each.
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

const TEST_USER_DATA = vi.hoisted(() => `/tmp/magimail-lazy-test-${process.pid}-${Date.now()}`);

/** Every view the manager has constructed, in order, with its mock webContents. */
const constructedViews = vi.hoisted(() => [] as MockView[]);

interface MockWebContents {
  loadURL: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setBackgroundThrottling: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn>;
  partition: string;
}
interface MockView {
  webContents: MockWebContents;
}

vi.mock('../src/native-toolbar.js', () => ({
  attachNativeToolbar: vi.fn(),
  updateNativeToolbarAccounts: vi.fn(),
  setNativeToolbarItemEnabled: vi.fn(),
  setNativeToolbarShareUrl: vi.fn(),
  showNativeSharingPicker: vi.fn(),
}));

vi.mock('@magimail/core', async () => {
  const actual = await vi.importActual<typeof import('@magimail/core')>('@magimail/core');
  return { ...actual, configureGoogleSession: vi.fn(), injectGmailStyles: vi.fn() };
});

vi.mock('electron', () => {
  class MockWebContentsView {
    webContents: MockWebContents;
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();
    setVisible = vi.fn();

    constructor(opts?: { webPreferences?: { partition?: string } }) {
      let destroyed = false;
      this.webContents = {
        partition: opts?.webPreferences?.partition ?? '',
        loadURL: vi.fn(),
        close: vi.fn(() => {
          destroyed = true;
        }),
        setBackgroundThrottling: vi.fn(),
        isDestroyed: vi.fn(() => destroyed),
        getURL: vi.fn().mockReturnValue('https://mail.google.com/mail/u/0/#inbox'),
        // Unused by these tests, but the manager wires them on every view.
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        isLoading: vi.fn().mockReturnValue(false),
        insertCSS: vi.fn().mockResolvedValue(''),
        removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
        setWindowOpenHandler: vi.fn(),
        executeJavaScript: vi.fn().mockResolvedValue(false),
        mainFrame: { frames: [] },
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
    on = vi.fn((event: string, cb: () => void) => {
      windowHandlers.set(event, cb);
    });
  }

  return {
    BaseWindow: MockBaseWindow,
    BrowserWindow: MockBaseWindow,
    WebContentsView: MockWebContentsView,
    webFrameMain: { fromId: vi.fn() },
    dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn() },
    clipboard: { writeText: vi.fn() },
    session: {
      fromPartition: vi.fn().mockReturnValue({
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn() },
      }),
      defaultSession: {
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn() },
      },
    },
    app: { getPath: vi.fn().mockReturnValue(TEST_USER_DATA), dock: { setBadge: vi.fn() } },
    shell: { openExternal: vi.fn() },
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
        name: 'A',
        partition: 'persist:a',
        color: '#111111',
        unreadCount: 0,
      },
      {
        id: ACCOUNT_B,
        name: 'B',
        partition: 'persist:b',
        color: '#222222',
        unreadCount: 0,
      },
    ]),
  );
}

/** The view the manager built for a partition, or undefined if it never built one. */
function viewFor(partition: string): MockView | undefined {
  return constructedViews.find((v) => v.webContents.partition === partition);
}

/** Fire a window event the manager subscribed to in initialize(). */
function emitWindowEvent(event: 'hide' | 'show'): void {
  (BaseWindow as unknown as { __handlers: Map<string, () => void> }).__handlers.get(event)?.();
}

describe('lazy account views', () => {
  let manager: AccountsManager;

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
    const win = new BaseWindow();
    win.contentView.children.length = 0;
    manager = new AccountsManager(win, '/preload.js');
    manager.initialize();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a view only for the account shown at launch', () => {
    expect(constructedViews).toHaveLength(1);
    expect(constructedViews[0].webContents.partition).toBe('persist:a');
    expect(viewFor('persist:b')).toBeUndefined();
    expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(false);
  });

  // The Atom poller fetches through session.fromPartition() from the main
  // process, so an unopened account's partition must still carry the clean
  // User-Agent and header sanitisation or Google sees an Electron client on the
  // feed request. Before views became lazy this happened as a side effect of
  // building a view per account, which is exactly why it needs pinning here.
  it('configures the partition of every account, including unopened ones', () => {
    const partitions = vi.mocked(configureGoogleSession).mock.calls.map(([partition]) => partition);

    expect(partitions).toContain('persist:a');
    expect(partitions).toContain('persist:b');
    expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(false);
  });

  it('configures the partition of a newly added account that has no view', () => {
    vi.mocked(configureGoogleSession).mockClear();
    const added = manager.addAccount('C', '#333333');

    const partitions = vi.mocked(configureGoogleSession).mock.calls.map(([partition]) => partition);
    expect(partitions).toContain(`persist:magimail_${added.id}`);
    expect(manager.isAccountLoaded(added.id)).toBe(false);
  });

  it('navigates only the launched account, leaving the rest unloaded', () => {
    expect(viewFor('persist:a')!.webContents.loadURL).toHaveBeenCalledWith(
      expect.stringContaining('mail.google.com'),
    );
    expect(constructedViews).toHaveLength(1);
  });

  it('builds and navigates the second account on first switch', () => {
    manager.switchAccount(ACCOUNT_B);

    const viewB = viewFor('persist:b');
    expect(viewB).toBeDefined();
    expect(viewB!.webContents.loadURL).toHaveBeenCalledWith(
      expect.stringContaining('mail.google.com'),
    );
    expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(true);
  });

  it('keeps a just-abandoned account alive so rapid switching costs no reload', () => {
    manager.switchAccount(ACCOUNT_B);

    expect(viewFor('persist:a')!.webContents.close).not.toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
  });

  it('destroys an account left inactive for the grace period', () => {
    manager.switchAccount(ACCOUNT_B);
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

    expect(viewFor('persist:a')!.webContents.close).toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
    // The account the user is looking at is untouched.
    expect(viewFor('persist:b')!.webContents.close).not.toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(true);
  });

  it('cancels a pending suspend when the account is switched back to', () => {
    manager.switchAccount(ACCOUNT_B);
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS / 2);
    manager.switchAccount(ACCOUNT_A);
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

    expect(viewFor('persist:a')!.webContents.close).not.toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
  });

  it('returns a resumed account to where it was, not to the inbox', () => {
    const threadUrl = 'https://mail.google.com/mail/u/0/#inbox/thread-f:12345';
    viewFor('persist:a')!.webContents.getURL.mockReturnValue(threadUrl);

    manager.switchAccount(ACCOUNT_B);
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
    manager.switchAccount(ACCOUNT_A);

    // A fresh view was built for A; it must resume the thread it was showing.
    const resumed = constructedViews.filter((v) => v.webContents.partition === 'persist:a').at(-1)!;
    expect(resumed.webContents.loadURL).toHaveBeenCalledWith(threadUrl);
  });

  it('throttles accounts once they leave the screen and unthrottles the active one', () => {
    manager.switchAccount(ACCOUNT_B);

    expect(viewFor('persist:a')!.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(
      true,
    );
    expect(viewFor('persist:b')!.webContents.setBackgroundThrottling).toHaveBeenLastCalledWith(
      false,
    );
  });

  it('ages out the visible account too once the window is hidden', () => {
    emitWindowEvent('hide');
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

    expect(viewFor('persist:a')!.webContents.close).toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
  });

  it('ages out the visible account of a window built hidden for a background action', () => {
    // A window created hidden for a notification's triage button never fires `hide`, so
    // nothing else arms the teardown. Without this its account stays resident for the life
    // of the app, ignoring the user's suspend setting.
    manager.handleWindowHidden();
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

    expect(viewFor('persist:a')!.webContents.close).toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
  });

  it('never ages it out when the threshold is Never, even built hidden', () => {
    manager.setSuspendDelayMinutes(SUSPEND_NEVER);
    manager.handleWindowHidden();
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS * 10);

    expect(viewFor('persist:a')!.webContents.close).not.toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
  });

  it('restores the unloaded account when the window is shown with no other request', async () => {
    emitWindowEvent('hide');
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
    emitWindowEvent('show');
    await Promise.resolve();

    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
  });

  it('does not resurrect the outgoing account when the tray shows a different one', async () => {
    // tray.showAccount shows the window first, then asks for its account.
    emitWindowEvent('hide');
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
    const viewsAfterUnload = constructedViews.length;

    emitWindowEvent('show');
    manager.switchAccount(ACCOUNT_B);
    await Promise.resolve();

    expect(manager.isAccountLoaded(ACCOUNT_B)).toBe(true);
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(false);
    // Exactly one new view — B's. A was never rebuilt just to be abandoned.
    expect(constructedViews).toHaveLength(viewsAfterUnload + 1);
  });

  it('keeps the visible account when the window is shown again in time', () => {
    emitWindowEvent('hide');
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS / 2);
    emitWindowEvent('show');
    vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

    expect(viewFor('persist:a')!.webContents.close).not.toHaveBeenCalled();
    expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
  });

  it('adds an account without building a renderer for it', () => {
    const before = constructedViews.length;
    const added = manager.addAccount('C', '#333333');

    expect(constructedViews).toHaveLength(before);
    expect(manager.isAccountLoaded(added.id)).toBe(false);
  });

  it('releases every account view on teardown', () => {
    manager.switchAccount(ACCOUNT_B);
    manager.suspendAllAccounts();

    expect(viewFor('persist:a')!.webContents.close).toHaveBeenCalled();
    expect(viewFor('persist:b')!.webContents.close).toHaveBeenCalled();
  });

  describe('configurable inactivity threshold', () => {
    it('honours a longer threshold chosen before switching away', () => {
      manager.setSuspendDelayMinutes(30);
      manager.switchAccount(ACCOUNT_B);

      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);
      expect(viewFor('persist:a')!.webContents.close).not.toHaveBeenCalled();

      vi.advanceTimersByTime(30 * 60 * 1000);
      expect(viewFor('persist:a')!.webContents.close).toHaveBeenCalled();
    });

    it('never unloads when set to Never', () => {
      manager.setSuspendDelayMinutes(SUSPEND_NEVER);
      manager.switchAccount(ACCOUNT_B);
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);

      expect(viewFor('persist:a')!.webContents.close).not.toHaveBeenCalled();
      expect(manager.isAccountLoaded(ACCOUNT_A)).toBe(true);
    });

    it('cancels an account already waiting when switched to Never', () => {
      manager.switchAccount(ACCOUNT_B);
      manager.setSuspendDelayMinutes(SUSPEND_NEVER);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS * 10);

      expect(viewFor('persist:a')!.webContents.close).not.toHaveBeenCalled();
    });

    it('re-arms an account already waiting when the threshold is shortened', () => {
      manager.switchAccount(ACCOUNT_B);
      manager.setSuspendDelayMinutes(1);
      vi.advanceTimersByTime(60 * 1000);

      expect(viewFor('persist:a')!.webContents.close).toHaveBeenCalled();
    });

    it('ignores a nonsensical threshold rather than disabling suspension', () => {
      manager.setSuspendDelayMinutes(-5);
      manager.switchAccount(ACCOUNT_B);
      vi.advanceTimersByTime(DEFAULT_SUSPEND_DELAY_MS);

      expect(viewFor('persist:a')!.webContents.close).toHaveBeenCalled();
    });
  });

  describe('account view attachment', () => {
    it('keeps only the account on screen attached while switching', () => {
      manager.switchAccount(ACCOUNT_B);
      const win = manager.getMainWindow();

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
      expect(viewFor('persist:a')!.setVisible).toHaveBeenCalledWith(true);
    });

    it('hides a view attached for a background action', () => {
      manager.switchAccount(ACCOUNT_B);
      manager.switchAccount(ACCOUNT_A);
      const viewB = viewFor('persist:b')!;
      const win = manager.getMainWindow();

      const restore = (
        manager as unknown as {
          sizeForBackgroundAction: (v: unknown, id: string) => () => void;
        }
      ).sizeForBackgroundAction(viewB, ACCOUNT_B);

      expect(viewB.setVisible).toHaveBeenCalledWith(false);
      expect(win.contentView.children[0]).toBe(viewB);

      restore();
      expect(viewB.setVisible).toHaveBeenCalledWith(true);
      expect(win.contentView.children).not.toContain(viewB);
    });

    it('shows a background-action view once it becomes the account on screen', () => {
      manager.switchAccount(ACCOUNT_B);
      manager.switchAccount(ACCOUNT_A);
      const viewB = viewFor('persist:b')!;

      const restore = (
        manager as unknown as {
          sizeForBackgroundAction: (v: unknown, id: string) => () => void;
        }
      ).sizeForBackgroundAction(viewB, ACCOUNT_B);

      expect(viewB.setVisible).toHaveBeenCalledWith(false);

      manager.switchAccount(ACCOUNT_B);
      expect(viewB.setVisible).toHaveBeenCalledWith(true);

      restore();
      expect(viewB.setVisible).toHaveBeenCalledWith(true);
      expect(manager.getMainWindow().contentView.children).toContain(viewB);
    });
  });

  // Cold launch: a cold launch from a widget or notification opens on the account the link
  // named. `initialize()` builds one view, so the account it belongs to is the account
  // the launch chose.
  describe('cold start account selection', () => {
    afterEach(() => {
      saveSetting('lastActiveAccountId', '');
    });

    it('builds the launch-linked account, not the first in the list', () => {
      constructedViews.length = 0;
      const linked = new AccountsManager(new BaseWindow(), '/preload.js');
      linked.setInitialAccountId(ACCOUNT_B);
      linked.initialize();

      expect(linked.getActiveAccountId()).toBe(ACCOUNT_B);
      expect(constructedViews).toHaveLength(1);
      expect(constructedViews[0].webContents.partition).toBe('persist:b');
      expect(viewFor('persist:a')).toBeUndefined();
    });

    it('restores the last active account when no link names one', () => {
      saveSetting('lastActiveAccountId', ACCOUNT_B);
      constructedViews.length = 0;

      const restored = new AccountsManager(new BaseWindow(), '/preload.js');
      restored.initialize();

      expect(restored.getActiveAccountId()).toBe(ACCOUNT_B);
      expect(constructedViews).toHaveLength(1);
      expect(constructedViews[0].webContents.partition).toBe('persist:b');
    });

    it('falls back to the first account when the link names one that is gone', () => {
      constructedViews.length = 0;
      const linked = new AccountsManager(new BaseWindow(), '/preload.js');
      linked.setInitialAccountId('account_removed');
      linked.initialize();

      expect(linked.getActiveAccountId()).toBe(ACCOUNT_A);
      expect(constructedViews).toHaveLength(1);
      expect(constructedViews[0].webContents.partition).toBe('persist:a');
    });

    it('records the account on screen on the way out', () => {
      manager.switchAccount(ACCOUNT_B);
      manager.persistActiveAccount();

      expect(loadSettings().lastActiveAccountId).toBe(ACCOUNT_B);
    });
  });
});
