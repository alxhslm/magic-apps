import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BaseWindow } from 'electron';
import { AccountsManager } from '../src/accounts-manager.js';

const TEST_USER_DATA = vi.hoisted(
  () => `/tmp/magical-presenting-test-${process.pid}-${Date.now()}`,
);

interface MockWebContents {
  loadURL: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setBackgroundThrottling: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn>;
  getTitle: ReturnType<typeof vi.fn>;
  partition: string;
  handlers: Map<string, (...args: unknown[]) => void>;
  isLoading: ReturnType<typeof vi.fn>;
  capturePage: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

interface MockView {
  webContents: MockWebContents;
  getBounds: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  setBackgroundColor: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
}

const constructedViews = vi.hoisted(() => [] as MockView[]);

vi.mock('@magimail/core', async () => {
  const actual = await vi.importActual<typeof import('@magimail/core')>('@magimail/core');
  return { ...actual, configureGoogleSession: vi.fn() };
});

const windowHandlers = vi.hoisted(() => new Map<string, () => void>());

vi.mock('electron', () => {
  class MockWebContentsView {
    webContents: MockWebContents;
    setBounds = vi.fn();
    getBounds = vi.fn().mockReturnValue({ x: 0, y: 38, width: 1200, height: 762 });
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
        getURL: vi
          .fn()
          .mockReturnValue('https://calendar.google.com/calendar/u/0/r/month/2026/10/1'),
        getTitle: vi.fn().mockReturnValue('Google Calendar'),
        handlers,
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, handler);
        }),
        once: vi.fn(),
        off: vi.fn(),
        isLoading: vi.fn().mockReturnValue(false),
        capturePage: vi.fn().mockResolvedValue({
          isEmpty: () => false,
          getSize: () => ({ width: 1200, height: 762 }),
          toBitmap: () => Buffer.alloc(1200 * 762 * 4, 0), // Uniform transparent frame
        }),
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
        emit: (event: string, ...args: unknown[]) => {
          handlers.get(event)?.(...args);
        },
      } as unknown as MockWebContents;
      constructedViews.push(this as unknown as MockView);
    }
  }

  const children: unknown[] = [];

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
    getBounds = vi.fn().mockReturnValue({ x: 100, y: 100, width: 1200, height: 800 });
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

const ACCOUNT_ID = 'test_account';

function seedAccounts(accounts: Array<{ id: string; name: string; partition: string }>): void {
  fs.mkdirSync(TEST_USER_DATA, { recursive: true });
  fs.writeFileSync(path.join(TEST_USER_DATA, 'accounts.json'), JSON.stringify(accounts, null, 2));
}

function emitWindowEvent(name: string): void {
  const handler = windowHandlers.get(name);
  if (!handler) throw new Error(`No window handler for ${name}`);
  handler();
}

describe('Rebuilding an account view when it stops presenting', () => {
  let manager: AccountsManager;
  let window: BaseWindow;

  beforeEach(() => {
    vi.useFakeTimers();
    constructedViews.length = 0;
    windowHandlers.clear();

    seedAccounts([
      {
        id: ACCOUNT_ID,
        name: 'Work',
        partition: 'persist:magical_work',
      },
    ]);

    window = new BaseWindow();
    manager = new AccountsManager(window, '/fake/preload.js');
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_USER_DATA, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  });

  it('does not rebuild if the view has not yet finished loading', async () => {
    emitWindowEvent('show');
    const view = constructedViews[0];

    // capturePage returns a uniform frame, but did-finish-load has not fired
    const rebuilt = await manager.checkActiveViewPresenting();
    expect(rebuilt).toBe(false);
    expect(constructedViews).toHaveLength(1);
    expect(view.webContents.close).not.toHaveBeenCalled();
  });

  it('does not rebuild if the view is currently loading', async () => {
    emitWindowEvent('show');
    const view = constructedViews[0];
    // Emit did-finish-load once
    view.webContents.emit('did-finish-load');

    // But now it is loading again
    view.webContents.isLoading.mockReturnValue(true);

    const rebuilt = await manager.checkActiveViewPresenting();
    expect(rebuilt).toBe(false);
    expect(constructedViews).toHaveLength(1);
  });

  it('does not rebuild if the captured frame is non-uniform (content is presenting)', async () => {
    emitWindowEvent('show');
    const view = constructedViews[0];
    view.webContents.emit('did-finish-load');
    view.webContents.isLoading.mockReturnValue(false);

    // Frame has real content (mixed pixels)
    const contentBuffer = Buffer.alloc(1200 * 762 * 4, 0);
    contentBuffer[100] = 0x55;
    view.webContents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1200, height: 762 }),
      toBitmap: () => contentBuffer,
    });

    const rebuilt = await manager.checkActiveViewPresenting();
    expect(rebuilt).toBe(false);
    expect(constructedViews).toHaveLength(1);
  });

  it('rebuilds the view when a loaded view presents a uniform frame, preserving the route', async () => {
    emitWindowEvent('show');
    const initialView = constructedViews[0];
    initialView.webContents.getURL.mockReturnValue(
      'https://calendar.google.com/calendar/u/0/r/month/2026/10/1',
    );
    initialView.webContents.emit('did-finish-load');
    initialView.webContents.isLoading.mockReturnValue(false);

    // Uniform transparent frame (all zeros)
    initialView.webContents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1200, height: 762 }),
      toBitmap: () => Buffer.alloc(1200 * 762 * 4, 0),
    });

    const rebuilt = await manager.checkActiveViewPresenting();
    expect(rebuilt).toBe(true);

    // Old view was closed
    expect(initialView.webContents.close).toHaveBeenCalled();

    // Fresh replacement view was built
    expect(constructedViews).toHaveLength(2);
    const replacementView = constructedViews[1];

    // Replaced view loads the route the user was on
    expect(replacementView.webContents.loadURL).toHaveBeenCalledWith(
      'https://calendar.google.com/calendar/u/0/r/month/2026/10/1',
    );
  });

  it('enforces a 1-minute cooldown before rebuilding again', async () => {
    emitWindowEvent('show');
    const initialView = constructedViews[0];
    initialView.webContents.emit('did-finish-load');
    initialView.webContents.isLoading.mockReturnValue(false);

    const rebuiltFirst = await manager.checkActiveViewPresenting();
    expect(rebuiltFirst).toBe(true);
    expect(constructedViews).toHaveLength(2);

    const secondView = constructedViews[1];
    secondView.webContents.emit('did-finish-load');
    secondView.webContents.isLoading.mockReturnValue(false);

    // Advance by 30 seconds (less than 1 minute)
    vi.advanceTimersByTime(30_000);

    const rebuiltSecond = await manager.checkActiveViewPresenting();
    expect(rebuiltSecond).toBe(false);
    expect(constructedViews).toHaveLength(2);

    // Advance another 35 seconds (past 60s cooldown)
    vi.advanceTimersByTime(35_000);

    const rebuiltThird = await manager.checkActiveViewPresenting();
    expect(rebuiltThird).toBe(true);
    expect(constructedViews).toHaveLength(3);
  });

  it('schedules a check on show and once more 3 seconds later', async () => {
    const view = constructedViews[0];
    view.webContents.emit('did-finish-load');
    view.webContents.isLoading.mockReturnValue(false);

    // Non-uniform frame so it checks without triggering a rebuild cooldown
    const contentBuffer = Buffer.alloc(1200 * 762 * 4, 0);
    contentBuffer[100] = 0x55;
    view.webContents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1200, height: 762 }),
      toBitmap: () => contentBuffer,
    });

    emitWindowEvent('show');

    // Immediate check ran during show
    await Promise.resolve();
    expect(view.webContents.capturePage).toHaveBeenCalledTimes(1);

    // 3 seconds later, follow-up check runs
    vi.advanceTimersByTime(3000);
    await Promise.resolve();
    expect(view.webContents.capturePage).toHaveBeenCalledTimes(2);
  });

  it('cancels the scheduled check if the window is hidden before it fires', async () => {
    const view = constructedViews[0];
    view.webContents.emit('did-finish-load');
    view.webContents.isLoading.mockReturnValue(false);

    // Non-uniform frame so it checks without triggering a rebuild cooldown
    const contentBuffer = Buffer.alloc(1200 * 762 * 4, 0);
    contentBuffer[100] = 0x55;
    view.webContents.capturePage.mockResolvedValue({
      isEmpty: () => false,
      getSize: () => ({ width: 1200, height: 762 }),
      toBitmap: () => contentBuffer,
    });

    emitWindowEvent('show');
    await Promise.resolve();
    expect(view.webContents.capturePage).toHaveBeenCalledTimes(1);

    // Hide the window after 1 second
    vi.advanceTimersByTime(1000);
    emitWindowEvent('hide');

    // Advance remaining 2 seconds
    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    // No second check occurred
    expect(view.webContents.capturePage).toHaveBeenCalledTimes(1);
  });
});
