import { describe, it, expect, vi, beforeEach, afterAll, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BaseWindow } from 'electron';
import { DOM_DRIVE_PREAMBLE } from '@magimail/core';
import {
  AccountsManager,
  asThreadAction,
  THREAD_ACTIONS,
  TRIAGE_ACTIONS,
} from '../src/accounts-manager.js';
import type { NotificationCategory } from '../src/constants.js';
import type { ThreadActionDriver } from '../src/thread-actions/index.js';

// Where account-store writes accounts.json: a per-run dir, removed in afterAll.
// Hoisted because the vi.mock factory below is hoisted above the imports.
const TEST_USER_DATA = vi.hoisted(() => `/tmp/magimail-accounts-test-${process.pid}-${Date.now()}`);

// Capture warnings so the action-diagnostic tests can assert them.
const logWarn = vi.hoisted(() => vi.fn());
vi.mock('@magimail/core/logger', async () => {
  const actual =
    await vi.importActual<typeof import('@magimail/core/logger')>('@magimail/core/logger');
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() }),
  };
});

// Mock native toolbar (requires native addon that isn't available in test)
vi.mock('../src/native-toolbar.js', () => ({
  attachNativeToolbar: vi.fn(),
  updateNativeToolbarAccounts: vi.fn(),
  setNativeToolbarItemEnabled: vi.fn(),
  setNativeToolbarShareUrl: vi.fn(),
  showNativeSharingPicker: vi.fn(),
}));

// Mock @magimail/core — configureGoogleSession imports `session` from electron
// internally and the test-level electron mock doesn't reach into the core package
vi.mock('@magimail/core', async () => {
  const actual = await vi.importActual<typeof import('@magimail/core')>('@magimail/core');
  return {
    ...actual,
    configureGoogleSession: vi.fn(),
    injectGmailStyles: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock Electron components
vi.mock('electron', () => {
  const mockWebContents = {
    loadURL: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
    loadFile: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
    isLoading: vi.fn().mockReturnValue(false),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    sendInputEvent: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue(''),
    isDestroyed: vi.fn().mockReturnValue(false),
    executeJavaScript: vi.fn().mockResolvedValue(false),
    getURL: vi.fn().mockReturnValue('https://mail.google.com/mail/u/0/#inbox'),
    getTitle: vi.fn().mockReturnValue('Test Subject'),
    mainFrame: {
      frames: [],
    },
    print: vi.fn(),
    printToPDF: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 test')),
    canGoBack: vi.fn().mockReturnValue(true),
    goBack: vi.fn(),
    canGoForward: vi.fn().mockReturnValue(true),
    goForward: vi.fn(),
  };

  class MockWebContentsView {
    webContents = { ...mockWebContents };
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();
  }

  const mockChildren: unknown[] = [];
  const windowHandlers = new Map<string, (...args: unknown[]) => void>();

  const mockContentView = {
    children: mockChildren,
    addChildView: vi.fn((view: unknown) => {
      mockChildren.push(view);
    }),
    removeChildView: vi.fn((view: unknown) => {
      const idx = mockChildren.indexOf(view);
      if (idx >= 0) mockChildren.splice(idx, 1);
    }),
  };

  class MockBrowserWindow {
    static __handlers = windowHandlers;
    show = vi.fn();
    focus = vi.fn();
    destroy = vi.fn();
    loadURL = vi.fn().mockResolvedValue(undefined);
    contentView = mockContentView;
    webContents = { ...mockWebContents };
    on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      windowHandlers.set(event, cb);
    });
    getContentSize = vi.fn().mockReturnValue([1200, 800]);
    getNativeWindowHandle = vi.fn().mockReturnValue(Buffer.alloc(8));
  }

  return {
    BaseWindow: MockBrowserWindow,
    BrowserWindow: MockBrowserWindow,
    WebContentsView: MockWebContentsView,
    webFrameMain: {
      fromId: vi.fn(),
    },
    dialog: {
      showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/test.pdf' }),
    },
    clipboard: {
      writeText: vi.fn(),
    },
    session: {
      fromPartition: vi.fn().mockReturnValue({
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn() },
        clearStorageData: vi.fn().mockResolvedValue(undefined),
        clearCache: vi.fn().mockResolvedValue(undefined),
      }),
      defaultSession: {
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn() },
      },
    },
    app: {
      getPath: vi.fn().mockReturnValue(TEST_USER_DATA),
      dock: {
        setBadge: vi.fn(),
      },
    },
    shell: {
      openExternal: vi.fn(),
    },
  };
});

/** The last enabled state pushed for a toolbar item, or undefined if never set. */
function lastToolbarState(mock: Mock, itemId: string): boolean | undefined {
  const calls = mock.mock.calls.filter((call) => call[0] === itemId);
  return calls.length ? (calls[calls.length - 1][1] as boolean) : undefined;
}

describe('AccountsManager', () => {
  let accountsManager: AccountsManager;
  let mockWin: BaseWindow;

  afterAll(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockWin = new BaseWindow();
    accountsManager = new AccountsManager(mockWin, '/path/to/preload.js');
    accountsManager.initialize();
  });

  it('initializes with default Personal account', () => {
    const accounts = accountsManager.getAccounts();
    expect(accounts.length).toBe(1);
    expect(accounts[0].name).toBe('Personal');
    expect(accountsManager.getActiveAccountId()).toBe('account_personal');
  });

  it('calls onAccountsChanged when adding, updating, and removing accounts', () => {
    const onChanged = vi.fn();
    accountsManager.onAccountsChanged = onChanged;

    // 1. Add account
    const added = accountsManager.addAccount('Work', '#ef4444');
    expect(added.name).toBe('Work');
    expect(added.color).toBe('#ef4444');
    expect(onChanged).toHaveBeenCalledTimes(1);

    // 2. Update account config (rename & recolor)
    const updated = accountsManager.updateAccountConfig(added.id, {
      name: 'Work Email',
      color: '#22c55e',
    });
    expect(updated).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(2);

    const accounts = accountsManager.getAccounts();
    const updatedAccount = accounts.find((a) => a.id === added.id);
    expect(updatedAccount?.name).toBe('Work Email');
    expect(updatedAccount?.color).toBe('#22c55e');

    // 3. Remove account
    const removed = accountsManager.removeAccount(added.id);
    expect(removed).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  it("deletes a removed account's poller state itself", () => {
    const added = accountsManager.addAccount('Work', '#ef4444');
    // What the account's poller leaves behind: seen ids and unhandled arrivals.
    const stateFile = path.join(TEST_USER_DATA, 'atom-state', `${added.id}.json`);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ seenIds: ['m1'] }));

    expect(accountsManager.removeAccount(added.id)).toBe(true);

    // Left in `atom-state/`, it is a record of seen messages for a mailbox nobody has,
    // and the call sites in main.ts are not the only way an account can go.
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('drops a removed account from the Focus Filter it was named by', () => {
    const added = accountsManager.addAccount('Work', '#ef4444');
    accountsManager.setFocusFilter({
      activeAccountIds: ['account_personal', added.id],
      disableExcludedAccounts: false,
      isFilterActive: true,
    });

    expect(accountsManager.removeAccount(added.id)).toBe(true);

    // The filter survives for the accounts that are left; `focus-filter.json` is the App
    // Intents extension's to rewrite, not this app's.
    expect(accountsManager.getFocusFilter()?.activeAccountIds).toEqual(['account_personal']);
  });

  it('resets the session for the account named, not the one on screen', async () => {
    const added = accountsManager.addAccount('Work', '#ef4444');
    const { session } = await import('electron');
    const fromPartition = vi.mocked(session.fromPartition);
    fromPartition.mockClear();

    // The Settings → Accounts button acts on the account selected in its list; the
    // active account is still Personal.
    await accountsManager.resetSession(added.id);

    expect(fromPartition).toHaveBeenCalledTimes(1);
    expect(fromPartition).toHaveBeenCalledWith(added.partition);
  });

  it('updates unread count from an Atom poll result', () => {
    // The Atom poller is the only source of unread counts; there is no
    // renderer/title-driven path.
    accountsManager.handleExternalUnreadUpdate('account_personal', 5);
    expect(accountsManager.getAccounts()[0].unreadCount).toBe(5);
  });

  it('announces a cache-derived count once, not on every re-read of the same cache', () => {
    // A renderer that is awake answers every cache read, and the widget snapshot
    // read calls back into this through `onUnreadChanged`. Announcing an
    // unchanged total re-entered the read, so the two calls span forever and the
    // badge was pinned to whatever the cache last said. Only a real change is news.
    const onUnreadChanged = vi.fn();
    accountsManager.onUnreadChanged = onUnreadChanged;

    // The sidebar's Inbox row is the inbox-scoped count; categories are the cache's.
    accountsManager.handleDomUnreadUpdate('account_personal', {
      timestamp: Date.now(),
      counts: { inbox: 3 },
      presentCategories: ['inbox'],
      isLoaded: true,
    });
    onUnreadChanged.mockClear();

    const cached = new Map<NotificationCategory, number>([
      ['primary', 3],
      ['updates', 2],
      ['promotions', 0],
      ['social', 0],
      ['forums', 0],
    ]);

    accountsManager.handleCacheCategoryCounts('account_personal', cached);
    expect(accountsManager.getAccounts()[0].unreadCount).toBe(5);
    expect(onUnreadChanged).toHaveBeenCalledTimes(1);

    accountsManager.handleCacheCategoryCounts('account_personal', new Map(cached));
    expect(onUnreadChanged).toHaveBeenCalledTimes(1);
  });

  it('triggers mail actions via semantic DOM execution', async () => {
    const activeView = accountsManager.getActiveWebContentsView();
    expect(activeView).toBeDefined();

    (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValueOnce(true);
    const result = await accountsManager.triggerMailAction('archive');
    expect(result).toBe(true);
    expect(activeView?.webContents.executeJavaScript).toHaveBeenCalled();
  });

  it('enables each reply control from what the open thread renders', async () => {
    const { setNativeToolbarItemEnabled } = await import('../src/native-toolbar.js');
    const enabled = setNativeToolbarItemEnabled as unknown as Mock;
    enabled.mockClear();

    const activeView = accountsManager.getActiveWebContentsView();
    // The reply-control scan is the only executeJavaScript call carrying the Gmail
    // labels; it serialises the map's replyAll action, which holds "Reply to all".
    // Anything else (the share permalink lookup) resolves null.
    (activeView?.webContents.executeJavaScript as unknown as Mock).mockImplementation(
      (script: string) =>
        Promise.resolve(
          script.includes('Reply to all') ? { reply: true, replyAll: false, forward: true } : null,
        ),
    );

    accountsManager.updateToolbarActionState(
      'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
    );

    // Checked synchronously, before the scan can resolve: nothing but the scan
    // may switch reply-to-all on. The bug this covers was the thread-state pass
    // enabling it for every open thread, which each in-page navigation then
    // repeated — so asserting only the settled value would pass either way.
    expect(lastToolbarState(enabled, 'replyAll')).not.toBe(true);

    await vi.waitFor(() => {
      expect(lastToolbarState(enabled, 'reply')).toBe(true);
    });
    expect(lastToolbarState(enabled, 'replyAll')).toBe(false);
    expect(lastToolbarState(enabled, 'reply')).toBe(true);
    expect(lastToolbarState(enabled, 'forward')).toBe(true);
    // The group stays enabled because some of its members are.
    expect(lastToolbarState(enabled, 'replyGroup')).toBe(true);
  });

  it('disables every reply control on a list view', async () => {
    const { setNativeToolbarItemEnabled } = await import('../src/native-toolbar.js');
    const enabled = setNativeToolbarItemEnabled as unknown as Mock;
    enabled.mockClear();

    accountsManager.updateToolbarActionState('https://mail.google.com/mail/u/0/#inbox');

    for (const id of ['reply', 'replyAll', 'forward', 'replyGroup']) {
      expect(lastToolbarState(enabled, id)).toBe(false);
    }
  });

  /**
   * Drive a notification action to completion while the route gate polls on a
   * timer, without waiting out its five seconds of wall clock.
   */
  async function runWithClock(promise: Promise<unknown>) {
    await vi.advanceTimersByTimeAsync(6000);
    return promise;
  }

  it('routes to a notification thread in-page rather than reloading', async () => {
    const activeView = accountsManager.getActiveWebContentsView();
    expect(activeView).toBeDefined();
    const wc = activeView!.webContents;
    const run = wc.executeJavaScript as unknown as Mock;
    run.mockClear();

    // Gmail resolves the Atom feed's legacy id and rewrites the hash to its own
    // canonical form, so the id asked for stops appearing in the URL exactly
    // when the thread appears on screen. Arrival cannot be detected by the id.
    let routed = false;
    run.mockImplementation((script: string) => {
      if (String(script).includes('location.hash =')) routed = true;
      return Promise.resolve(undefined);
    });
    (wc.getURL as unknown as Mock).mockImplementation(() =>
      routed
        ? 'https://mail.google.com/mail/u/0/#inbox/FMfcgzGmockThreadId00000000000001'
        : 'https://mail.google.com/mail/u/0/?pli=1#inbox',
    );
    (wc.getTitle as unknown as Mock).mockImplementation(() => (routed ? 'A Thread' : 'Inbox'));

    vi.useFakeTimers();
    await runWithClock(accountsManager.performThreadAction('account_personal', 'msg_123', 'open'));
    vi.useRealTimers();

    // Loading the view itself still goes through loadURL; navigating to the
    // thread must not — that is a full reload, and it destroys an open compose.
    const loaded = (wc.loadURL as unknown as Mock).mock.calls.map(([u]) => String(u));
    expect(loaded.some((u) => u.includes('msg_123'))).toBe(false);
    const script = run.mock.calls.map(([s]) => String(s)).join('\n');
    expect(script).toContain('msg_123');
    expect(script).toContain('location.hash');
  });

  it('delegates triage actions directly to the mailbox source without DOM routing', async () => {
    const source = accountsManager.getMailboxSource('account_personal');
    expect(source).toBeDefined();
    const triageSpy = vi.spyOn(source!, 'triageThread').mockResolvedValue(true);

    const wc = accountsManager.getActiveWebContentsView()!.webContents;
    const run = wc.executeJavaScript as unknown as Mock;
    run.mockClear();

    const result = await accountsManager.performThreadAction(
      'account_personal',
      'msg_123',
      'archive',
    );
    expect(result).toBe(true);
    expect(triageSpy).toHaveBeenCalledWith('msg_123', 'archive');

    const scripts = run.mock.calls.map(([s]) => String(s));
    expect(scripts.some((s) => s.includes('location.hash ='))).toBe(false);
    expect(scripts.some((s) => s.includes('act='))).toBe(false);
  });

  it('never shows or focuses the window for an action button', async () => {
    const wc = accountsManager.getActiveWebContentsView()!.webContents;
    let routed = false;
    (wc.executeJavaScript as unknown as Mock).mockImplementation((script: string) => {
      if (String(script).includes('location.hash =')) routed = true;
      return Promise.resolve(undefined);
    });
    (wc.getURL as unknown as Mock).mockImplementation(() =>
      routed
        ? 'https://mail.google.com/mail/u/0/#inbox/FMfcgzGmockThreadId00000000000001'
        : 'https://mail.google.com/mail/u/0/?pli=1#inbox',
    );
    (wc.getTitle as unknown as Mock).mockImplementation(() => (routed ? 'A Thread' : 'Inbox'));

    const show = mockWin.show as unknown as Mock;
    const focus = mockWin.focus as unknown as Mock;

    for (const action of ['archive', 'trash', 'markRead', 'markUnread'] as const) {
      routed = false;
      show.mockClear();
      focus.mockClear();

      vi.useFakeTimers();
      await runWithClock(
        accountsManager.performThreadAction('account_personal', 'msg_123', action),
      );
      vi.useRealTimers();

      // Triage fired at a banner must not pull the user out of whatever they
      // were doing — that is the whole point of doing it in the background.
      expect(show).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
    }

    // Opening one is a request to look at the thread, so it may come forward.
    routed = false;
    show.mockClear();
    vi.useFakeTimers();
    await runWithClock(accountsManager.performThreadAction('account_personal', 'msg_123', 'open'));
    vi.useRealTimers();
    expect(show).toHaveBeenCalled();
  });

  it('delegates markUnread and markRead directly to mailbox source', async () => {
    const source = accountsManager.getMailboxSource('account_personal');
    expect(source).toBeDefined();
    const triageSpy = vi.spyOn(source!, 'triageThread').mockResolvedValue(true);

    let result = await accountsManager.performThreadAction(
      'account_personal',
      'msg_123',
      'markUnread',
    );
    expect(result).toBe(true);
    expect(triageSpy).toHaveBeenCalledWith('msg_123', 'markUnread');

    result = await accountsManager.performThreadAction('account_personal', 'msg_123', 'markRead');
    expect(result).toBe(true);
    expect(triageSpy).toHaveBeenCalledWith('msg_123', 'markRead');
  });

  it('wakes a sleeping account, loads Gmail, and runs action in background', async () => {
    const work = accountsManager.addAccount('Work', '#3b82f6');
    const show = mockWin.show as unknown as Mock;
    const focus = mockWin.focus as unknown as Mock;
    show.mockClear();
    focus.mockClear();

    const actionPromise = (async () => {
      return accountsManager.performThreadAction(work.id, 'msg_work_99', 'archive');
    })();

    const children = (
      mockWin.contentView as unknown as {
        children: Array<{
          webContents: { executeJavaScript: Mock; loadURL: Mock; getURL: Mock; getTitle: Mock };
        }>;
      }
    ).children;
    const workView = children[children.length - 1];
    expect(workView).toBeDefined();
    const workWc = workView.webContents;

    let routed = false;
    (workWc.executeJavaScript as unknown as Mock).mockImplementation((script: string) => {
      if (String(script).includes('[role="main"]')) return Promise.resolve(true);
      if (String(script).includes('location.hash =')) {
        routed = true;
        return Promise.resolve(true);
      }
      return Promise.resolve(true);
    });
    (workWc.getURL as unknown as Mock).mockImplementation(() =>
      routed
        ? 'https://mail.google.com/mail/u/1/#inbox/FMfcgzQhWork99'
        : 'https://mail.google.com/mail/u/1/#inbox',
    );
    (workWc.getTitle as unknown as Mock).mockImplementation(() =>
      routed ? 'Work Thread' : 'Inbox',
    );

    vi.useFakeTimers();
    await runWithClock(actionPromise);
    vi.useRealTimers();

    expect(workWc.loadURL).toHaveBeenCalledWith(
      'https://accounts.google.com/ServiceLogin?service=mail&continue=https://mail.google.com/mail/',
    );
    expect(show).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(accountsManager.getActiveAccountId()).toBe('account_personal');
  });

  it('skips routing when open or markRead is invoked on an already-open thread', async () => {
    const activeView = accountsManager.getActiveWebContentsView();
    const wc = activeView!.webContents;
    const run = wc.executeJavaScript as unknown as Mock;
    run.mockClear();
    (wc.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox/msg_already_there',
    );

    await accountsManager.performThreadAction('account_personal', 'msg_already_there', 'open');
    const openScripts = run.mock.calls.map(([s]) => String(s));
    // Opening may scan toolbar reply controls on switchAccount, but must not route the thread
    expect(openScripts.some((s) => s.includes('location.hash ='))).toBe(false);

    run.mockClear();
    await accountsManager.performThreadAction('account_personal', 'msg_already_there', 'markRead');
    // A successful action may press the refresh control; it must not route the thread.
    const triageScripts = run.mock.calls.map(([s]) => String(s));
    expect(triageScripts.some((s) => s.includes('location.hash ='))).toBe(false);
    expect(triageScripts.some((s) => s.includes('__magimailPrevHash'))).toBe(false);
  });

  it('refuses to route away when in-page editor or dialog guard rejects', async () => {
    const activeView = accountsManager.getActiveWebContentsView();
    const wc = activeView!.webContents;
    const run = wc.executeJavaScript as unknown as Mock;
    run.mockClear();
    (wc.getURL as unknown as Mock).mockReturnValue('https://mail.google.com/mail/u/0/#inbox');
    (wc.getTitle as unknown as Mock).mockReturnValue('Inbox');

    run.mockImplementation((script: string) => {
      const s = String(script);
      if (s.includes('data-legacy-thread-id')) return Promise.resolve(false);
      if (s.includes('window.__magimailPrevHash')) return Promise.resolve(false);
      return Promise.resolve(true);
    });

    vi.useFakeTimers();
    await runWithClock(
      accountsManager.performThreadAction('account_personal', 'msg_456', 'archive'),
    );
    vi.useRealTimers();

    const scripts = run.mock.calls.map(([s]) => String(s));
    expect(scripts.some((s) => s.includes('act='))).toBe(false);
  });

  it('never reaches for Gmail act numbers that are not read controls', async () => {
    const activeView = accountsManager.getActiveWebContentsView();
    const run = activeView?.webContents.executeJavaScript as unknown as Mock;
    run.mockClear();

    accountsManager.toggleReadState();
    await accountsManager.triggerMailAction('markRead');
    await accountsManager.triggerMailAction('markUnread');

    // Selectors are JSON-escaped into the injected script, so match either form.
    const script = run.mock.calls.map(([s]) => String(s)).join('\n');
    const act = (n: number) => new RegExp(`act=\\\\?"${n}\\\\?"`);
    // act 9 is Report spam and act 8 is Move to Inbox; the read controls are 1 and 2.
    expect(script).not.toMatch(act(9));
    expect(script).not.toMatch(act(8));
    expect(script).toMatch(act(1));
    expect(script).toMatch(act(2));
  });

  it('accurately identifies thread URLs versus list URLs', () => {
    expect(
      accountsManager.isThreadUrl('https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789'),
    ).toBe(true);
    expect(
      accountsManager.isThreadUrl('https://mail.google.com/mail/u/0/#all/18d8e3b52a123456'),
    ).toBe(true);
    expect(
      accountsManager.isThreadUrl(
        'https://mail.google.com/mail/u/0/#search/meeting/FMfcgzGxT123456789',
      ),
    ).toBe(true);
    expect(
      accountsManager.isThreadUrl(
        'https://mail.google.com/mail/u/0/#label/projects/FMfcgzGxT123456789',
      ),
    ).toBe(true);

    expect(accountsManager.isThreadUrl('https://mail.google.com/mail/u/0/#inbox')).toBe(false);
    expect(accountsManager.isThreadUrl('https://mail.google.com/mail/u/0/#starred')).toBe(false);
    expect(accountsManager.isThreadUrl('https://mail.google.com/mail/u/0/#all')).toBe(false);
    expect(accountsManager.isThreadUrl('https://mail.google.com/mail/u/0/#label/work')).toBe(false);
  });

  it('updates toolbar action state and notifies thread state listeners', async () => {
    const onThreadStateChanged = vi.fn();
    accountsManager.onThreadStateChanged = onThreadStateChanged;

    const { setNativeToolbarItemEnabled, setNativeToolbarShareUrl } =
      await import('../src/native-toolbar.js');

    await accountsManager.updateToolbarActionState('https://mail.google.com/mail/u/0/#inbox');
    expect(setNativeToolbarItemEnabled).toHaveBeenCalledWith('print', false);
    expect(setNativeToolbarItemEnabled).toHaveBeenCalledWith('share', false);
    expect(onThreadStateChanged).toHaveBeenCalledWith(false);
    // The native share picker reads its items synchronously, so a list view has
    // to clear the link rather than leave the last thread's behind.
    expect(setNativeToolbarShareUrl).toHaveBeenCalledWith('');

    const threadUrl = 'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789';
    await accountsManager.updateToolbarActionState(threadUrl);
    expect(setNativeToolbarItemEnabled).toHaveBeenCalledWith('print', true);
    expect(setNativeToolbarItemEnabled).toHaveBeenCalledWith('share', true);
    expect(onThreadStateChanged).toHaveBeenCalledWith(true);
    expect(setNativeToolbarShareUrl).toHaveBeenCalledWith(threadUrl);
  });

  it('does not disable toolbar actions if a late fragment-less navigation arrives while viewing a thread', async () => {
    const { setNativeToolbarItemEnabled } = await import('../src/native-toolbar.js');
    const enabled = setNativeToolbarItemEnabled as unknown as Mock;
    enabled.mockClear();

    const activeView = accountsManager.getActiveWebContentsView();
    const threadUrl = 'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789';
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(threadUrl);

    // Initial state: thread is open
    accountsManager.updateToolbarActionState(threadUrl);
    expect(enabled).toHaveBeenCalledWith('print', true);
    expect(enabled).toHaveBeenCalledWith('share', true);

    enabled.mockClear();

    // A document-level HTTP navigation event (did-navigate) arrives with a URL without fragment
    accountsManager.updateToolbarActionState('https://mail.google.com/mail/u/0/');

    // Toolbar actions must remain enabled because active view is still on a thread
    expect(enabled).not.toHaveBeenCalledWith('print', false);
    expect(enabled).not.toHaveBeenCalledWith('share', false);
    expect(enabled).toHaveBeenCalledWith('print', true);
    expect(enabled).toHaveBeenCalledWith('share', true);
  });

  it('prompts user when copying link without an open thread, copies URL when thread is open', async () => {
    const { dialog, clipboard } = await import('electron');
    const activeView = accountsManager.getActiveWebContentsView();

    // Case 1: In list view
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox',
    );
    (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(false);
    await accountsManager.copyActiveThreadLink();
    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();

    // Case 2: In thread view
    vi.clearAllMocks();
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
    );
    await accountsManager.copyActiveThreadLink();
    expect(clipboard.writeText).toHaveBeenCalledWith(
      'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
    );
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('invokes native sharing picker when thread is open, prompts dialog when on list view', async () => {
    const { dialog } = await import('electron');
    const { showNativeSharingPicker } = await import('../src/native-toolbar.js');
    const activeView = accountsManager.getActiveWebContentsView();

    // Case 1: In list view
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox',
    );
    (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(false);
    await accountsManager.shareActiveThreadLink();
    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(showNativeSharingPicker).not.toHaveBeenCalled();

    // Case 2: In thread view
    vi.clearAllMocks();
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
    );
    await accountsManager.shareActiveThreadLink();
    expect(showNativeSharingPicker).toHaveBeenCalledWith(mockWin, [
      'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
    ]);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('exports active thread to PDF using save dialog without opening print dialog', async () => {
    const { dialog } = await import('electron');
    const activeView = accountsManager.getActiveWebContentsView();

    // Case 1: In list view -> prompt dialog
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox',
    );
    (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(false);
    await accountsManager.exportActiveThreadToPdf();
    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(activeView?.webContents.printToPDF).not.toHaveBeenCalled();

    // Case 2: In thread view -> showSaveDialog, printToPDF
    vi.clearAllMocks();
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
    );
    (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(
      'Project Update',
    );
    await accountsManager.exportActiveThreadToPdf();
    expect(dialog.showSaveDialog).toHaveBeenCalled();
    expect(activeView?.webContents.printToPDF).toHaveBeenCalledWith({ printBackground: true });
    expect(activeView?.webContents.print).not.toHaveBeenCalled();
  });

  it('shares active thread as PDF via native sharing picker', async () => {
    const { dialog } = await import('electron');
    const { showNativeSharingPicker } = await import('../src/native-toolbar.js');
    const activeView = accountsManager.getActiveWebContentsView();

    // Case 1: In list view -> prompt dialog
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox',
    );
    (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(false);
    await accountsManager.shareActiveThreadAsPdf();
    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(showNativeSharingPicker).not.toHaveBeenCalled();

    // Case 2: In thread view -> printToPDF and native sharing
    vi.clearAllMocks();
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
    );
    (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue('Invoice');
    await accountsManager.shareActiveThreadAsPdf();
    expect(activeView?.webContents.printToPDF).toHaveBeenCalledWith({ printBackground: true });
    expect(showNativeSharingPicker).toHaveBeenCalled();
    expect(activeView?.webContents.print).not.toHaveBeenCalled();
  });

  it('prints active view directly using webContents.print when thread is open', async () => {
    const { dialog } = await import('electron');
    const activeView = accountsManager.getActiveWebContentsView();

    // Case 1: In list view -> prompt dialog
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox',
    );
    (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(false);
    await accountsManager.printActiveView();
    expect(dialog.showMessageBox).toHaveBeenCalled();
    expect(activeView?.webContents.print).not.toHaveBeenCalled();

    // Case 2: In thread view -> calls print directly
    vi.clearAllMocks();
    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
    );
    await accountsManager.printActiveView();
    expect(activeView?.webContents.print).toHaveBeenCalledWith(
      {
        silent: false,
        printBackground: true,
      },
      expect.any(Function),
    );
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('navigates history back and forward for active webContents', () => {
    const activeView = accountsManager.getActiveWebContentsView();
    expect(activeView).toBeDefined();

    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox',
    );
    (activeView!.webContents.canGoBack as unknown as Mock).mockReturnValue(true);
    expect(accountsManager.canGoBack()).toBe(true);
    expect(accountsManager.goBack()).toBe(true);
    expect(activeView!.webContents.goBack).toHaveBeenCalledTimes(1);

    (activeView!.webContents.canGoBack as unknown as Mock).mockReturnValue(false);
    expect(accountsManager.canGoBack()).toBe(false);
    expect(accountsManager.goBack()).toBe(false);

    (activeView!.webContents.canGoForward as unknown as Mock).mockReturnValue(true);
    expect(accountsManager.canGoForward()).toBe(true);
    expect(accountsManager.goForward()).toBe(true);
    expect(activeView!.webContents.goForward).toHaveBeenCalledTimes(1);

    (activeView!.webContents.canGoForward as unknown as Mock).mockReturnValue(false);
    expect(accountsManager.canGoForward()).toBe(false);
    expect(accountsManager.goForward()).toBe(false);
  });

  it('navigates back to list view when viewing a thread with no history entry', () => {
    const activeView = accountsManager.getActiveWebContentsView();
    expect(activeView).toBeDefined();

    (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
    );
    (activeView!.webContents.canGoBack as unknown as Mock).mockReturnValue(false);

    expect(accountsManager.canGoBack()).toBe(true);
    expect(accountsManager.goBack()).toBe(true);
    const script = (activeView!.webContents.executeJavaScript as unknown as Mock).mock.calls.at(
      -1,
    )![0] as string;
    expect(script).toContain('findAction(document');
    // The list keeps its own scroll position; the only defence needed is that the
    // row Gmail re-focuses on the way back cannot scroll the list into view.
    expect(script).toContain('preventScroll: true');
    expect(script).not.toContain('scrollIntoView');
    expect(script).not.toContain('scrollTop');
  });

  it('updates account auth requirement and notifies listeners', () => {
    const onChanged = vi.fn();
    const onUnreadChanged = vi.fn();
    accountsManager.onAccountsChanged = onChanged;
    accountsManager.onUnreadChanged = onUnreadChanged;

    // Initial state: needsAuth is undefined or false
    expect(accountsManager.getAccounts()[0].needsAuth).toBeFalsy();

    // Set auth required to true
    accountsManager.setAccountAuthRequired('account_personal', true);
    expect(accountsManager.getAccounts()[0].needsAuth).toBe(true);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(onUnreadChanged).toHaveBeenCalledTimes(1);

    // Setting same state does not trigger redundant notifications
    accountsManager.setAccountAuthRequired('account_personal', true);
    expect(onChanged).toHaveBeenCalledTimes(1);

    // Clear auth required
    accountsManager.setAccountAuthRequired('account_personal', false);
    expect(accountsManager.getAccounts()[0].needsAuth).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('renders the offline page only for a main-frame network failure', () => {
    const activeView = accountsManager.getActiveWebContentsView();
    const loadURL = activeView?.webContents.loadURL as unknown as Mock;
    const listeners = (activeView?.webContents.on as unknown as Mock).mock.calls.filter(
      (call) => call[0] === 'did-fail-load',
    );
    // The handler registered last belongs to this test's manager.
    const didFailLoad = listeners[listeners.length - 1][1] as (...args: unknown[]) => void;
    const target = 'https://mail.google.com/mail/u/0/';
    loadURL.mockClear();

    // ERR_ABORTED is Chromium cancelling a navigation that was replaced -- it
    // fires on every ordinary in-app redirect and means nothing is wrong.
    didFailLoad({}, -3, 'ERR_ABORTED', target, true);
    expect(loadURL).not.toHaveBeenCalled();

    // A subframe that failed is Gmail's own business; replacing the whole view
    // would throw away a working mailbox over one dead iframe.
    didFailLoad({}, -106, 'ERR_INTERNET_DISCONNECTED', target, false);
    expect(loadURL).not.toHaveBeenCalled();

    didFailLoad({}, -106, 'ERR_INTERNET_DISCONNECTED', target, true);
    const rendered = loadURL.mock.calls[0][0] as string;
    expect(rendered.startsWith('data:text/html')).toBe(true);
    expect(decodeURIComponent(rendered)).toContain("You're offline");

    // The page it replaced is what reconnecting goes back to -- not the Gmail
    // root, which would drop whatever thread was open.
    loadURL.mockClear();
    accountsManager.handleNetworkStatusChange(true);
    expect(loadURL).toHaveBeenCalledWith(target);
  });

  it('handles network reconnect and reloads failed offline URL', () => {
    const activeView = accountsManager.getActiveWebContentsView();
    expect(activeView).toBeDefined();
    (activeView?.webContents.loadURL as unknown as Mock).mockClear();

    // Simulate offline failed URL recorded
    (
      accountsManager as unknown as { failedOfflineUrls: Map<string, string> }
    ).failedOfflineUrls.set('account_personal', 'https://mail.google.com/mail/u/0/#inbox');

    // Offline event should not reload
    accountsManager.handleNetworkStatusChange(false);
    expect(activeView?.webContents.loadURL).not.toHaveBeenCalled();

    // Online event should reload the failed URL and clear the recorded URL
    accountsManager.handleNetworkStatusChange(true);
    expect(activeView?.webContents.loadURL).toHaveBeenCalledWith(
      'https://mail.google.com/mail/u/0/#inbox',
    );
    expect(
      (
        accountsManager as unknown as { failedOfflineUrls: Map<string, string> }
      ).failedOfflineUrls.has('account_personal'),
    ).toBe(false);
  });
});

describe('the verdict performThreadAction reports', () => {
  /**
   * `routeAcrossWindow` reads this verdict to decide whether the window it built for a triage
   * action actually served it, so the manager has to pass the driver's answer out.
   */
  function withDriver(landed: boolean): { manager: AccountsManager; perform: Mock } {
    const perform = vi.fn().mockResolvedValue(landed);
    const manager = new AccountsManager(new BaseWindow(), '/path/to/preload.js', undefined, {
      perform,
    } as unknown as ThreadActionDriver);
    manager.initialize();
    return { manager, perform };
  }

  it('reports triage that landed', async () => {
    const { manager, perform } = withDriver(true);

    await expect(manager.performThreadAction('account_personal', 'msg_1', 'archive')).resolves.toBe(
      true,
    );
    expect(perform).toHaveBeenCalledWith(undefined, 'account_personal', 'msg_1', 'archive');
  });

  it('reports triage that did not', async () => {
    const { manager } = withDriver(false);

    await expect(manager.performThreadAction('account_personal', 'msg_1', 'archive')).resolves.toBe(
      false,
    );
  });

  it('reports an unknown account as not landed', async () => {
    const { manager, perform } = withDriver(true);

    await expect(manager.performThreadAction('no_such_account', 'msg_1', 'archive')).resolves.toBe(
      false,
    );
    expect(perform).not.toHaveBeenCalled();
  });
});

/** Fire a window event the manager subscribed to through `mainWindow.on`. */
function emitWindowEvent(event: 'hide' | 'show'): void {
  (BaseWindow as unknown as { __handlers?: Map<string, () => void> }).__handlers?.get(event)?.();
}

describe('action diagnostics', () => {
  let manager: AccountsManager;

  beforeEach(() => {
    manager = new AccountsManager(new BaseWindow(), '/path/to/preload.js');
    manager.initialize();
  });

  it('warns when a mailbox action finds no control', async () => {
    logWarn.mockClear();
    const wc = manager.getActiveWebContentsView()!.webContents;
    (wc.executeJavaScript as unknown as Mock).mockResolvedValueOnce(false);

    const ok = await manager.triggerMailAction('archive');

    expect(ok).toBe(false);
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining('No archive control in account_personal'),
    );
  });

  it('wakes a suspended account to toggle read state', async () => {
    const wc = manager.getActiveWebContentsView()!.webContents;
    const run = wc.executeJavaScript as unknown as Mock;
    const load = wc.loadURL as unknown as Mock;
    (wc.getURL as unknown as Mock).mockReturnValue('https://mail.google.com/mail/u/0/#inbox');
    run.mockClear();
    run.mockResolvedValue(true);
    load.mockClear();
    manager.suspendAllAccounts();

    manager.toggleReadState();

    // The suspended active account is rebuilt and pointed back at where it was,
    // rather than the toggle being dropped for want of a view.
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith('https://mail.google.com/mail/u/0/#inbox');
      expect(run).toHaveBeenCalledWith(expect.stringMatching(/act=\\?"2\\?"/));
    });
  });

  it('wakes a suspended account to focus search', async () => {
    const wc = manager.getActiveWebContentsView()!.webContents;
    const run = wc.executeJavaScript as unknown as Mock;
    const load = wc.loadURL as unknown as Mock;
    (wc.getURL as unknown as Mock).mockReturnValue('https://mail.google.com/mail/u/0/#inbox');
    run.mockClear();
    run.mockResolvedValue(true);
    load.mockClear();
    manager.suspendAllAccounts();

    manager.focusSearchInActiveView();

    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith('https://mail.google.com/mail/u/0/#inbox');
      expect(run).toHaveBeenCalledWith(expect.stringMatching(/input\[name=\\?"q\\?"\]/));
    });
  });

  it('wakes a suspended account for a compose pop-out', async () => {
    const wc = manager.getActiveWebContentsView()!.webContents;
    const run = wc.executeJavaScript as unknown as Mock;
    const load = wc.loadURL as unknown as Mock;
    (wc.getURL as unknown as Mock).mockReturnValue('https://mail.google.com/mail/u/0/#inbox');
    run.mockClear();
    run.mockResolvedValue(true);
    load.mockClear();
    manager.suspendAllAccounts();

    const pending = manager.triggerComposePopout();

    await vi.waitFor(() => {
      expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    // Gmail creates the window through `did-create-window`, which the mock never
    // fires on its own; stand in for it so the call does not sit on its timeout.
    const handler = (wc.on as unknown as Mock).mock.calls
      .filter(([event]) => event === 'did-create-window')
      .pop()?.[1] as (win: unknown) => void;
    const composeWin = {
      once: vi.fn(),
      webContents: { on: vi.fn(), setWindowOpenHandler: vi.fn() },
    };
    handler(composeWin);

    await expect(pending).resolves.toBe(composeWin);
  });

  it('wakes a suspended account when the system resumes', async () => {
    const wc = manager.getActiveWebContentsView()!.webContents;
    const run = wc.executeJavaScript as unknown as Mock;
    const load = wc.loadURL as unknown as Mock;
    const reload = wc.reload as unknown as Mock;
    (wc.getURL as unknown as Mock).mockReturnValue('https://mail.google.com/mail/u/0/#inbox');
    run.mockClear();
    run.mockResolvedValue(true);
    load.mockClear();
    reload.mockClear();
    manager.suspendAllAccounts();

    manager.reloadActiveViewOnResume();

    // 18 of 27 resume wakes in the logs reloaded nothing because the active
    // account had no renderer; the wake is what makes the reload land.
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith('https://mail.google.com/mail/u/0/#inbox');
      expect(reload).toHaveBeenCalled();
    });
  });

  it('rebuilds the active account view on reloadActiveView', () => {
    const oldView = manager.getActiveWebContentsView()!;
    const oldWc = oldView.webContents;
    (oldWc.getURL as unknown as Mock).mockReturnValue('https://mail.google.com/mail/u/0/#starred');

    manager.reloadActiveView();

    const newView = manager.getActiveWebContentsView()!;
    expect(newView).not.toBe(oldView);
    expect(oldWc.close).toHaveBeenCalled();
    expect(newView.webContents.loadURL).toHaveBeenCalledWith(
      'https://mail.google.com/mail/u/0/#starred',
    );
  });

  it('wakes a suspended account to run a tray search', async () => {
    const wc = manager.getActiveWebContentsView()!.webContents;
    const load = wc.loadURL as unknown as Mock;
    const run = wc.executeJavaScript as unknown as Mock;
    (wc.getURL as unknown as Mock).mockReturnValue('https://mail.google.com/mail/u/0/#inbox');
    run.mockClear();
    run.mockResolvedValue(true);
    load.mockClear();
    manager.suspendAllAccounts();

    manager.openInAccount(undefined, 'https://mail.google.com/mail/u/0/#search/invoice');

    // The search field may name no account, and the one it runs in may be suspended
    // with the window hidden. One call has to switch it awake and then navigate it.
    await vi.waitFor(() => {
      expect(load).toHaveBeenCalledWith('https://mail.google.com/mail/u/0/#search/invoice');
    });
  });

  it('re-suspends the account on screen when an action wakes it while the window is hidden', async () => {
    vi.useFakeTimers();
    try {
      // The account on screen is only ever suspended while the window is hidden, so
      // an action that wakes it then has to hand the renderer back to the timer.
      emitWindowEvent('hide');
      manager.setSuspendDelayMinutes(1);

      const wc = manager.getActiveWebContentsView()!.webContents;
      const run = wc.executeJavaScript as unknown as Mock;
      (wc.getURL as unknown as Mock).mockReturnValue('https://mail.google.com/mail/u/0/#inbox');
      run.mockResolvedValue(true);
      manager.suspendAllAccounts();
      expect(manager.isAccountLoaded('account_personal')).toBe(false);

      await manager.triggerMailAction('archive', 'account_personal');
      expect(manager.isAccountLoaded('account_personal')).toBe(true);

      vi.advanceTimersByTime(60 * 1000);
      expect(manager.isAccountLoaded('account_personal')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('thread actions', () => {
  it('offers triage as everything except opening', () => {
    // Four surfaces reach performThreadAction and each used to carry its own list.
    // Only `open` raises the window, which is the whole distinction.
    expect([...THREAD_ACTIONS]).toContain('open');
    expect([...TRIAGE_ACTIONS]).not.toContain('open');
    expect([...TRIAGE_ACTIONS].sort()).toEqual(
      [...THREAD_ACTIONS].filter((a) => a !== 'open').sort(),
    );
  });

  it('refuses a string that is not an action rather than guessing one', () => {
    expect(asThreadAction('archive')).toBe('archive');
    expect(asThreadAction('Archive')).toBeUndefined();
    expect(asThreadAction('reply')).toBeUndefined();
    expect(asThreadAction(undefined)).toBeUndefined();
    expect(asThreadAction(7)).toBeUndefined();
  });

  it('refuses to open from a surface that only triages', () => {
    // A popover row and a notification button must never raise the window.
    expect(asThreadAction('open', TRIAGE_ACTIONS)).toBeUndefined();
    expect(asThreadAction('markUnread', TRIAGE_ACTIONS)).toBe('markUnread');
  });
});

describe('holding triage while the view is busy', () => {
  let manager: AccountsManager;

  beforeEach(() => {
    manager = new AccountsManager(new BaseWindow(), '/path/to/preload.js');
    manager.initialize();
  });

  /** The script `routeToThread` sends, which is the one that is retried. */
  const routeAttempts = (run: Mock) =>
    run.mock.calls.map(([s]) => String(s)).filter((s) => s.includes('__magimailPrevHash')).length;

  function view() {
    const wc = manager.getActiveWebContentsView()!.webContents;
    (wc.getURL as unknown as Mock).mockReturnValue('https://mail.google.com/mail/u/0/#inbox');
    (wc.getTitle as unknown as Mock).mockReturnValue('Inbox');
    const run = wc.executeJavaScript as unknown as Mock;
    run.mockClear();
    // Refuses the route and reports itself busy, the way an open compose does.
    run.mockImplementation((script: string) =>
      Promise.resolve(!String(script).includes('__magimailPrevHash')),
    );
    return run;
  }

  it('executes background triage immediately via mailbox source without being blocked by open compose editor', async () => {
    const run = view();
    const source = manager.getMailboxSource('account_personal');
    expect(source).toBeDefined();
    const triageSpy = vi.spyOn(source!, 'triageThread').mockResolvedValue(true);

    const result = await manager.performThreadAction('account_personal', 'msg_1', 'archive');
    expect(result).toBe(true);
    expect(triageSpy).toHaveBeenCalledWith('msg_1', 'archive');
    // Background triage does not attempt to route the view
    expect(routeAttempts(run)).toBe(0);
  });

  it('drops a refused open rather than raising the window later', async () => {
    const run = view();
    vi.useFakeTimers();

    await manager.performThreadAction('account_personal', 'msg_1', 'open');
    const refused = routeAttempts(run);

    run.mockImplementation(() => Promise.resolve(false));
    await vi.advanceTimersByTimeAsync(20_000);
    vi.useRealTimers();

    // Arriving five minutes late, over whatever the user moved on to, is worse than
    // not arriving.
    expect(routeAttempts(run)).toBe(refused);
  });
});

/**
 * What the manager does on the way out of a window.
 *
 * `suspendAllAccounts` runs from the window's `closed` handler, and a suspend timer
 * armed before the window went can fire after it, so the contentView is not always
 * there to detach from. The renderer still has to be released.
 */
describe('releasing account views on teardown', () => {
  it('releases the views when the window has gone, without touching its contentView', () => {
    const win = new BaseWindow();
    const manager = new AccountsManager(win, '/path/to/preload.js');
    manager.initialize();
    const wc = manager.getActiveWebContentsView()!.webContents;

    // The state a suspend timer fires in five minutes after the window closed.
    (win as unknown as { isDestroyed: () => boolean }).isDestroyed = () => true;

    expect(() => manager.suspendAllAccounts()).not.toThrow();
    expect(wc.close).toHaveBeenCalled();
  });
});
