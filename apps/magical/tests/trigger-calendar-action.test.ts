import { describe, it, expect, vi, type Mock } from 'vitest';
import vm from 'node:vm';
import { AccountsManager } from '../src/accounts-manager.js';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/magical-test') },
  WebContentsView: vi.fn().mockImplementation(function () {
    return {
      webContents: {
        loadURL: vi.fn(),
        getURL: vi.fn(() => 'https://calendar.google.com/calendar/u/0/r'),
        executeJavaScript: vi.fn().mockResolvedValue(true),
        sendInputEvent: vi.fn(),
        isDestroyed: vi.fn(() => false),
        isLoading: vi.fn(() => false),
        on: vi.fn(),
        off: vi.fn(),
        once: vi.fn(),
        reload: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        setBackgroundThrottling: vi.fn(),
        focus: vi.fn(),
        close: vi.fn(),
      },
      setBackgroundColor: vi.fn(),
      setBounds: vi.fn(),
    };
  }),
  session: {
    fromPartition: vi.fn(() => ({
      webRequest: { onBeforeSendHeaders: vi.fn(), onBeforeRequest: vi.fn() },
      setUserAgent: vi.fn(),
    })),
  },
  ipcMain: { on: vi.fn() },
}));

// Capture warnings so the action-diagnostic test can assert them.
const logWarn = vi.hoisted(() => vi.fn());
vi.mock('@magimail/core/logger', async () => {
  const actual =
    await vi.importActual<typeof import('@magimail/core/logger')>('@magimail/core/logger');
  return {
    ...actual,
    createLogger: () => ({ info: vi.fn(), warn: logWarn, error: vi.fn(), debug: vi.fn() }),
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

describe('triggerCalendarAction', () => {
  const mockWindow = {
    getContentSize: () => [1000, 800],
    on: vi.fn(),
    contentView: {
      children: [] as any[],
      addChildView: vi.fn(),
      removeChildView: vi.fn(),
    },
  } as any;

  it('triggers action by executing semantic DOM selector script', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const activeView = manager.getActiveView();
    expect(activeView).toBeDefined();

    const result = await manager.triggerCalendarAction('createEvent');
    expect(result).toBe(true);
    expect(activeView?.webContents.executeJavaScript).toHaveBeenCalled();
  });

  it('returns to calendar view when navToday is called in search view', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const activeView = manager.getActiveView();
    vi.mocked(activeView!.webContents.executeJavaScript).mockResolvedValueOnce(false);
    vi.mocked(activeView!.webContents.getURL).mockReturnValueOnce(
      'https://calendar.google.com/calendar/r/search?q=dentist',
    );

    const result = await manager.triggerCalendarAction('navToday');
    expect(result).toBe(true);
    expect(activeView?.webContents.loadURL).toHaveBeenCalledWith(
      'https://calendar.google.com/calendar/r',
    );
    expect(activeView?.webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it('returns to calendar view when navToday is called in eventedit view', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const activeView = manager.getActiveView();
    vi.mocked(activeView!.webContents.executeJavaScript).mockResolvedValueOnce(false);
    vi.mocked(activeView!.webContents.getURL).mockReturnValueOnce(
      'https://calendar.google.com/calendar/r/eventedit/123',
    );

    const result = await manager.triggerCalendarAction('navToday');
    expect(result).toBe(true);
    expect(activeView?.webContents.loadURL).toHaveBeenCalledWith(
      'https://calendar.google.com/calendar/r',
    );
    expect(activeView?.webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it('never sends simulated keyboard events', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const activeView = manager.getActiveView();
    vi.mocked(activeView!.webContents.executeJavaScript).mockResolvedValueOnce(false);
    vi.mocked(activeView!.webContents.getURL).mockReturnValueOnce(
      'https://calendar.google.com/calendar/r',
    );

    await manager.triggerCalendarAction('createEvent');
    await manager.triggerCalendarAction('search');
    await manager.triggerCalendarAction('navToday');

    expect(activeView?.webContents.sendInputEvent).not.toHaveBeenCalled();
  });

  it('does not fall back to the eventedit URL when the Create control is missing', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const activeView = manager.getActiveView();
    const load = activeView!.webContents.loadURL as unknown as Mock;
    load.mockClear();
    vi.mocked(activeView!.webContents.executeJavaScript).mockResolvedValueOnce(false);

    const result = await manager.triggerCalendarAction('createEvent');
    // Reporting success here while nothing opened was the bug: the URL was loaded
    // on a view that had never attached, so the user saw an action do nothing.
    expect(result).toBe(false);
    expect(load).not.toHaveBeenCalledWith('https://calendar.google.com/calendar/r/eventedit');
  });

  it('drives createEvent through the map, not an appointment-schedule exclusion', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const activeView = manager.getActiveView();
    let executedScript = '';
    vi.mocked(activeView!.webContents.executeJavaScript).mockImplementationOnce(
      async (script: string) => {
        executedScript = script;
        return true;
      },
    );

    await manager.triggerCalendarAction('createEvent');
    // The Create button is found by the map's scoped hook, and the menu item by its
    // `data-key`, so the English appointment-schedule exclusions are gone.
    expect(executedScript).toContain('createEvent');
    expect(executedScript).toContain('data-is-drawer-closed');
    expect(executedScript).toContain('data-key=\\"event\\"');
    expect(executedScript).not.toContain('appointment');
  });

  it('generates DOM script that expands search bar when search input is not visible', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const activeView = manager.getActiveView();
    let executedScript = '';
    vi.mocked(activeView!.webContents.executeJavaScript).mockImplementationOnce(
      async (script: string) => {
        executedScript = script;
        return true;
      },
    );

    await manager.triggerCalendarAction('search');
    // The expanded field is a child of the click, so the script waits on the DOM
    // primitive rather than polling a fixed fifteen times.
    expect(executedScript).toContain('waitUntil');
    expect(executedScript).toContain('search-input');
    expect(executedScript).not.toContain('pollForSearchInput');
  });

  it('waits for the Create menu rather than guessing a delay', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const activeView = manager.getActiveView();
    let executedScript = '';
    vi.mocked(activeView!.webContents.executeJavaScript).mockImplementationOnce(
      async (script: string) => {
        executedScript = script;
        return true;
      },
    );

    await manager.triggerCalendarAction('createEvent');
    expect(executedScript).toContain('create-menu');
    expect(executedScript).not.toContain('}, 60)');
  });

  it('generates a script that parses as page JavaScript', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const activeView = manager.getActiveView();
    let executedScript = '';
    vi.mocked(activeView!.webContents.executeJavaScript).mockImplementationOnce(
      async (script: string) => {
        executedScript = script;
        return true;
      },
    );

    await manager.triggerCalendarAction('createEvent');
    // The script is a template literal, so a stray backtick or brace is a syntax error
    // that only shows up in the page. Compiling it here catches that before the app runs.
    expect(() => new vm.Script(executedScript)).not.toThrow();
    expect(executedScript).toContain('(async () => {');
  });

  it('waits for Today after Back rather than guessing a delay', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const activeView = manager.getActiveView();
    let executedScript = '';
    vi.mocked(activeView!.webContents.executeJavaScript).mockImplementationOnce(
      async (script: string) => {
        executedScript = script;
        return true;
      },
    );

    await manager.triggerCalendarAction('navToday');
    expect(executedScript).toContain('today-after-back');
    expect(executedScript).not.toContain('}, 100)');
  });

  it('wakes a suspended account before dispatching the action', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const before = manager.getActiveView()!;
    (before.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://calendar.google.com/calendar/u/0/r',
    );
    manager.suspendAllAccounts();

    const result = await manager.triggerCalendarAction('search');

    expect(result).toBe(true);
    const woken = manager.getActiveView()!;
    expect(woken.webContents.loadURL).toHaveBeenCalledWith(
      'https://calendar.google.com/calendar/u/0/r',
    );
    expect(woken.webContents.executeJavaScript).toHaveBeenCalled();
  });

  it('wakes a suspended account for a notification navigation', async () => {
    const manager = new AccountsManager(mockWindow, '/fake/preload.js');
    const before = manager.getActiveView()!;
    (before.webContents.getURL as unknown as Mock).mockReturnValue(
      'https://calendar.google.com/calendar/u/0/r',
    );
    manager.suspendAllAccounts();

    const url = 'https://calendar.google.com/calendar/r/eventedit/abc';
    manager.openInAccount('account_personal', url);

    await vi.waitFor(() => {
      const woken = manager.getActiveView();
      expect(woken?.webContents.loadURL).toHaveBeenCalledWith(url);
    });
  });
});
