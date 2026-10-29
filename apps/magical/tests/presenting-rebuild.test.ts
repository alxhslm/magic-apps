import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BaseWindow } from 'electron';
import { AccountsManager } from '../src/accounts-manager.js';

const TEST_USER_DATA = vi.hoisted(
  () => `/tmp/magical-reload-rebuild-test-${process.pid}-${Date.now()}`,
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

describe('Rebuilding an account view on reload', () => {
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

  it('rebuilds the view through the pool rather than an in-place webContents.reload()', () => {
    expect(constructedViews).toHaveLength(1);
    const initialView = constructedViews[0];

    manager.reloadActive();

    // The old view's WebContents was closed
    expect(initialView.webContents.close).toHaveBeenCalledTimes(1);

    // A fresh WebContentsView was constructed
    expect(constructedViews).toHaveLength(2);
    const replacementView = constructedViews[1];
    expect(replacementView.webContents.close).not.toHaveBeenCalled();
  });

  it('preserves the user route when reloading via pool rebuild', () => {
    const initialView = constructedViews[0];
    initialView.webContents.getURL.mockReturnValue(
      'https://calendar.google.com/calendar/u/0/r/month/2026/11/15',
    );

    manager.reloadActive();

    expect(constructedViews).toHaveLength(2);
    const replacementView = constructedViews[1];

    // The fresh view returns to the date the user was viewing
    expect(replacementView.webContents.loadURL).toHaveBeenCalledWith(
      'https://calendar.google.com/calendar/u/0/r/month/2026/11/15',
    );
  });

  it('updates layout for the replacement view', () => {
    manager.reloadActive();

    const replacementView = constructedViews[1];
    expect(replacementView.setBounds).toHaveBeenCalled();
  });

  it('releases the views when the window has gone, without touching its contentView', () => {
    const initialView = constructedViews[0];
    const mockWindow = window as unknown as { isDestroyed: () => boolean };
    mockWindow.isDestroyed = () => true;

    expect(() => manager.suspendAllAccounts()).not.toThrow();

    // The renderer is what costs memory, so it is closed even with no window to detach from.
    expect(initialView.webContents.close).toHaveBeenCalledTimes(1);
  });
});
