/**
 * Calendar vs Tasks view mode in Magical.
 *
 * The mode is derived from the route and kept per account so switching away and back
 * returns to the same one. What these tests pin down is the detection boundary, that only
 * the account on screen is announced, and that an action which needs the calendar grid
 * leaves full-screen Tasks rather than failing against a page with no controls on it.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BaseWindow } from 'electron';
import { configureGoogleSession } from '@magimail/core';
import { AccountsManager } from '../src/accounts-manager.js';

const TEST_USER_DATA = vi.hoisted(() => `/tmp/magical-view-mode-${process.pid}-${Date.now()}`);

interface MockWebContents {
  partition: string;
  handlers: Map<string, (...args: unknown[]) => void>;
  setUrl: (url: string) => void;
  loadURL: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setBackgroundThrottling: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn>;
  getTitle: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  isLoading: ReturnType<typeof vi.fn>;
  insertCSS: ReturnType<typeof vi.fn>;
  removeInsertedCSS: ReturnType<typeof vi.fn>;
  setWindowOpenHandler: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  sendInputEvent: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  mainFrame: {
    url: string;
    frames: MockWebContents[];
    isDestroyed: () => boolean;
    executeJavaScript: ReturnType<typeof vi.fn>;
  };
}
interface MockView {
  webContents: MockWebContents;
}
interface MockWebContentsViewCtor {
  new (opts?: { webPreferences?: { partition?: string } }): MockView;
}

const constructedViews = vi.hoisted(() => [] as MockView[]);

vi.mock('@magimail/core', async () => {
  const actual = await vi.importActual<typeof import('@magimail/core')>('@magimail/core');
  return { ...actual, configureGoogleSession: vi.fn() };
});

vi.mock('electron', () => {
  class MockWebContentsView {
    webContents: MockWebContents;
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();

    constructor(opts?: { webPreferences?: { partition?: string } }) {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      let url = 'https://calendar.google.com/calendar/u/0/r';

      this.webContents = {
        partition: opts?.webPreferences?.partition ?? '',
        handlers,
        setUrl: (next: string) => {
          url = next;
        },
        loadURL: vi.fn((next: string) => {
          url = next;
          return Promise.resolve();
        }),
        close: vi.fn(),
        setBackgroundThrottling: vi.fn(),
        isDestroyed: vi.fn(() => false),
        getURL: vi.fn(() => url),
        getTitle: vi.fn(() => 'Calendar'),
        on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
          handlers.set(event, cb);
        }),
        once: vi.fn(),
        off: vi.fn(),
        isLoading: vi.fn(() => false),
        insertCSS: vi.fn().mockResolvedValue(''),
        removeInsertedCSS: vi.fn().mockResolvedValue(undefined),
        setWindowOpenHandler: vi.fn(),
        executeJavaScript: vi.fn().mockResolvedValue(true),
        sendInputEvent: vi.fn(),
        focus: vi.fn(),
        mainFrame: {
          url: 'https://calendar.google.com/calendar/u/0/r',
          frames: [] as MockWebContents[],
          isDestroyed: () => false,
          executeJavaScript: vi.fn().mockResolvedValue(true),
        },
      };
      constructedViews.push(this as unknown as MockView);
    }
  }

  class MockBaseWindow {
    contentView = {
      children: [] as unknown[],
      addChildView: vi.fn((v: unknown) => {
        (this.contentView.children as unknown[]).push(v);
      }),
      removeChildView: vi.fn((v: unknown) => {
        const i = (this.contentView.children as unknown[]).indexOf(v);
        if (i >= 0) (this.contentView.children as unknown[]).splice(i, 1);
      }),
    };
    show = vi.fn();
    focus = vi.fn();
    setBackgroundColor = vi.fn();
    getContentSize = vi.fn().mockReturnValue([1200, 800]);
    getNativeWindowHandle = vi.fn().mockReturnValue(Buffer.alloc(8));
    on = vi.fn();
  }

  return {
    BaseWindow: MockBaseWindow,
    WebContentsView: MockWebContentsView as unknown as MockWebContentsViewCtor,
    session: {
      fromPartition: vi.fn().mockReturnValue({
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn(), onBeforeRequest: vi.fn() },
        clearStorageData: vi.fn().mockResolvedValue(undefined),
      }),
    },
    app: { getPath: vi.fn().mockReturnValue(TEST_USER_DATA) },
    shell: { openExternal: vi.fn() },
    ipcMain: { on: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false },
  };
});

vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn(() => ({
    theme: 'system',
    transparentBackground: true,
    hideSidebar: false,
    addEventAccountPicker: 'active',
    inactiveAccountSuspendMinutes: 5,
  })),
  SUSPEND_NEVER: 0,
}));

const ACCOUNT_A = 'account_a';
const ACCOUNT_B = 'account_b';

function seedTwoAccounts(): void {
  fs.mkdirSync(TEST_USER_DATA, { recursive: true });
  fs.writeFileSync(
    path.join(TEST_USER_DATA, 'accounts.json'),
    JSON.stringify([
      { id: ACCOUNT_A, name: 'Personal', partition: 'persist:magical_personal', color: '#a855f7' },
      { id: ACCOUNT_B, name: 'Work', partition: 'persist:magical_work', color: '#3b82f6' },
    ]),
  );
}

function viewFor(partition: string): MockView | undefined {
  return constructedViews.find((v) => v.webContents.partition === partition);
}

/** Fires a web-contents event the manager subscribed to, as Chromium would. */
function emitNavigation(
  view: MockView,
  event: 'did-navigate' | 'did-navigate-in-page',
  url: string,
): void {
  view.webContents.setUrl(url);
  view.webContents.handlers.get(event)?.({}, url);
}

/**
 * Answers each injected script by what it asks for, so the route can be driven without a
 * page. The path is read back off the mock's own URL, so a `pushState` that a test drives
 * is visible to the next question the manager asks.
 */
function wireScripts(view: MockView): void {
  const here = (): string => {
    const parsed = new URL(view.webContents.getURL());
    return parsed.pathname + parsed.search;
  };

  vi.mocked(view.webContents.executeJavaScript).mockImplementation((script: string) => {
    const pushed = /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(script);
    if (pushed) {
      view.webContents.setUrl(`https://calendar.google.com${pushed[1]}`);
      return Promise.resolve(true);
    }
    if (script.includes('location.pathname + location.search')) return Promise.resolve(here());
    if (script.includes('data-viewkey')) return Promise.resolve(null);
    // isBusyEditing, which a Tasks view never answers true for.
    if (script.includes('eventedit')) return Promise.resolve(false);
    if (script.includes('elementFromPoint')) return Promise.resolve({ x: 120, y: 80 });
    if (script.includes('getBoundingClientRect'))
      return Promise.resolve({ x: 100, y: 100, width: 50, height: 30 });
    return Promise.resolve(true);
  });
}

const pushedPaths = (view: MockView): string[] =>
  vi
    .mocked(view.webContents.executeJavaScript)
    .mock.calls.map(([script]) => /history\.pushState\(\{\}, '', "([^"]+)"\)/.exec(script)?.[1])
    .filter((p): p is string => Boolean(p));

describe('Calendar vs Tasks view mode', () => {
  let manager: AccountsManager;
  let view: MockView;

  afterAll(() => {
    fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
  });

  beforeEach(() => {
    constructedViews.length = 0;
    vi.mocked(configureGoogleSession).mockClear();
    seedTwoAccounts();
    manager = new AccountsManager(new BaseWindow(), '/preload.js');
    view = viewFor('persist:magical_personal')!;
    wireScripts(view);
  });

  it('reads Tasks from the exact route, not a prefix that merely starts with it', () => {
    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/tasks',
    );
    expect(manager.getActiveViewMode()).toBe('tasks');

    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/tasksomething',
    );
    expect(manager.getActiveViewMode()).toBe('calendar');
  });

  it('announces a transition into Tasks and back, once per transition', () => {
    const onModeChanged = vi.fn();
    manager.onModeChanged = onModeChanged;

    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/tasks',
    );
    expect(onModeChanged).toHaveBeenCalledTimes(1);
    expect(onModeChanged).toHaveBeenCalledWith('tasks');

    // A second navigation that stays in Tasks is not a transition.
    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/tasks',
    );
    expect(onModeChanged).toHaveBeenCalledTimes(1);

    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/week/2026/9/17',
    );
    expect(onModeChanged).toHaveBeenCalledTimes(2);
    expect(onModeChanged).toHaveBeenLastCalledWith('calendar');
  });

  it('never announces a background account and preserves each account own mode', () => {
    const onModeChanged = vi.fn();
    manager.onModeChanged = onModeChanged;

    // A is on screen and goes into Tasks, which is announced.
    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/tasks',
    );
    expect(manager.getViewMode(ACCOUNT_A)).toBe('tasks');
    expect(onModeChanged).toHaveBeenCalledWith('tasks');
    onModeChanged.mockClear();

    manager.switchAccount(ACCOUNT_B);
    const viewB = viewFor('persist:magical_work')!;
    wireScripts(viewB);
    emitNavigation(
      viewB,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/month/2026/9/1',
    );

    // A is in the background now, so its own transition is recorded and not announced.
    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/month/2026/9/1',
    );
    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/tasks',
    );
    expect(onModeChanged).not.toHaveBeenCalled();
    expect(manager.getViewMode(ACCOUNT_A)).toBe('tasks');

    // Switching back restores each account's own mode rather than last one's.
    manager.switchAccount(ACCOUNT_A);
    expect(manager.getActiveViewMode()).toBe('tasks');
    expect(manager.getViewMode(ACCOUNT_B)).toBe('calendar');

    manager.switchAccount(ACCOUNT_B);
    expect(manager.getActiveViewMode()).toBe('calendar');
  });

  it('leaves full-screen Tasks for the calendar root before revealing an event', async () => {
    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/tasks',
    );

    const outcome = await manager.revealEvent(ACCOUNT_A, 'EID', new Date(2026, 8, 17));

    const pushed = pushedPaths(view);
    expect(pushed[0]).toBe('/calendar/u/0/r');
    expect(pushed.at(-1)).toBe('/calendar/u/0/r/day/2026/9/17');
    expect(outcome).toBe('revealed');
  });

  it('does not route a view already on the grid', async () => {
    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/week/2026/9/14',
    );

    await manager.revealEvent(ACCOUNT_A, 'EID', new Date(2026, 8, 17));

    // Straight to the day, with no detour through the root.
    expect(pushedPaths(view)).toEqual(['/calendar/u/0/r/week/2026/9/17']);
  });

  it('leaves Tasks before opening the event editor from the toolbar', async () => {
    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/tasks',
    );

    const clicked = await manager.triggerCalendarAction('createEvent', ACCOUNT_A);

    expect(pushedPaths(view)[0]).toBe('/calendar/u/0/r');
    expect(clicked).toBe(true);
  });

  it('creates a task in the grid without leaving Calendar mode', async () => {
    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/week/2026/9/14',
    );

    const created = await manager.triggerNewTask(ACCOUNT_A);

    expect(pushedPaths(view)).toEqual([]);
    expect(created).toBe(true);
    const scripts = vi.mocked(view.webContents.executeJavaScript).mock.calls.map(([s]) => s);
    expect(scripts.some((s) => s.includes('createTask') && s.includes('data-key'))).toBe(true);
  });

  it('focuses the task entry in Tasks mode instead of routing to the grid', async () => {
    emitNavigation(
      view,
      'did-navigate-in-page',
      'https://calendar.google.com/calendar/u/0/r/tasks',
    );

    const created = await manager.triggerNewTask(ACCOUNT_A);

    // The one thing this must not do is the thing New Event does: leave Tasks.
    expect(pushedPaths(view)).toEqual([]);
    expect(created).toBe(true);
    const scripts = vi
      .mocked(view.webContents.mainFrame.executeJavaScript)
      .mock.calls.map(([s]) => s);
    expect(scripts.some((s) => s.includes('task-entry'))).toBe(true);
  });
});
