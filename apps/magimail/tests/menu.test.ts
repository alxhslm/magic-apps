import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shell } from 'electron';
import { buildAppMenu } from '../src/menu.js';

vi.mock('electron', () => ({
  app: {
    name: 'Magimail',
    showAboutPanel: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn((template) => template),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

describe('buildAppMenu', () => {
  it('builds application menu containing File shortcuts', () => {
    const onNewMessage = vi.fn();
    const onNewPopoutCompose = vi.fn();

    const menu = buildAppMenu({
      onNewMessage,
      onNewPopoutCompose,
      accountNames: ['Personal', 'Work'],
    }) as unknown as Array<{
      label?: string;
      submenu?: Array<{ label?: string; accelerator?: string }>;
    }>;
    const fileMenu = menu.find((item) => item.label === 'File');

    expect(fileMenu).toBeDefined();
    expect(fileMenu?.submenu).toBeDefined();

    const newMsgItem = fileMenu?.submenu?.find((sub) => sub.label === 'New Message');
    expect(newMsgItem).toBeDefined();
    expect(newMsgItem?.accelerator).toBe('CmdOrCtrl+N');

    const popoutItem = fileMenu?.submenu?.find(
      (sub) => sub.label === 'New Detached Compose Window',
    );
    expect(popoutItem).toBeDefined();
    expect(popoutItem?.accelerator).toBe('CmdOrCtrl+Shift+N');

    const printItem = fileMenu?.submenu?.find((sub) => sub.label === 'Print...');
    expect(printItem).toBeDefined();
    expect(printItem?.accelerator).toBe('CmdOrCtrl+P');

    const exportPdfItem = fileMenu?.submenu?.find((sub) => sub.label === 'Export as PDF...');
    expect(exportPdfItem).toBeDefined();

    const shareMenu = fileMenu?.submenu?.find((sub) => sub.label === 'Share') as unknown as {
      label: string;
      submenu: Array<{ label?: string; enabled?: boolean; click?: () => void }>;
    };
    expect(shareMenu).toBeDefined();
    expect(shareMenu.submenu.find((sub) => sub.label === 'Copy Link')).toBeDefined();
    expect(shareMenu.submenu.find((sub) => sub.label === 'Share Link...')).toBeDefined();
    expect(shareMenu.submenu.find((sub) => sub.label === 'Share as PDF...')).toBeDefined();

    const accountsMenu = menu.find((item) => item.label === 'Accounts');
    expect(accountsMenu).toBeDefined();
    const personalItem = accountsMenu?.submenu?.find((sub) => sub.label === 'Personal');
    expect(personalItem?.accelerator).toBe('CmdOrCtrl+1');
    const workItem = accountsMenu?.submenu?.find((sub) => sub.label === 'Work');
    expect(workItem?.accelerator).toBe('CmdOrCtrl+2');
  });

  it('marks the account being viewed in the Accounts menu', () => {
    const menu = buildAppMenu({
      accountNames: ['Personal', 'Work', 'Side'],
      activeAccountIndex: 1,
    }) as unknown as Array<{
      label?: string;
      submenu?: Array<{ label?: string; type?: string; checked?: boolean }>;
    }>;

    const accounts = menu.find((item) => item.label === 'Accounts')?.submenu ?? [];
    const marked = accounts.filter((sub) => sub.checked).map((sub) => sub.label);

    // Exactly one, so the menu reads as a state indicator rather than a list of
    // commands that all look alike.
    expect(marked).toEqual(['Work']);
    expect(accounts.find((sub) => sub.label === 'Work')?.type).toBe('radio');
  });

  it('disables sharing and print menu items when no message is selected', () => {
    const onPrint = vi.fn();
    const onExportPdf = vi.fn();
    const onCopyLink = vi.fn();

    const menu = buildAppMenu({
      onNewMessage: vi.fn(),
      onNewPopoutCompose: vi.fn(),
      onPrint,
      onExportPdf,
      onCopyLink,
      isMessageSelected: false,
    }) as unknown as Array<{
      label?: string;
      submenu?: Array<{
        label?: string;
        enabled?: boolean;
        submenu?: Array<{ label?: string; enabled?: boolean }>;
      }>;
    }>;

    const fileMenu = menu.find((item) => item.label === 'File');
    const printItem = fileMenu?.submenu?.find((sub) => sub.label === 'Print...');
    expect(printItem?.enabled).toBe(false);

    const exportPdfItem = fileMenu?.submenu?.find((sub) => sub.label === 'Export as PDF...');
    expect(exportPdfItem?.enabled).toBe(false);

    const shareMenu = fileMenu?.submenu?.find((sub) => sub.label === 'Share');
    const copyLinkItem = shareMenu?.submenu?.find((sub) => sub.label === 'Copy Link');
    expect(copyLinkItem?.enabled).toBe(false);
  });

  it('includes Customize Toolbar in View menu when provided on macOS', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });

    try {
      const onCustomizeToolbar = vi.fn();
      const menu = buildAppMenu({
        onNewMessage: vi.fn(),
        onNewPopoutCompose: vi.fn(),
        onCustomizeToolbar,
      }) as unknown as Array<{
        label?: string;
        submenu?: Array<{ label?: string; click?: () => void }>;
      }>;

      const viewMenu = menu.find((item) => item.label === 'View');
      expect(viewMenu).toBeDefined();
      const customizeItem = viewMenu?.submenu?.find((sub) => sub.label === 'Customize Toolbar...');
      expect(customizeItem).toBeDefined();
      customizeItem?.click?.();
      expect(onCustomizeToolbar).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('omits Customize Toolbar from View menu on non-macOS platforms', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });

    try {
      const onCustomizeToolbar = vi.fn();
      const menu = buildAppMenu({
        onNewMessage: vi.fn(),
        onNewPopoutCompose: vi.fn(),
        onCustomizeToolbar,
      }) as unknown as Array<{
        label?: string;
        submenu?: Array<{ label?: string }>;
      }>;

      const viewMenu = menu.find((item) => item.label === 'View');
      expect(viewMenu).toBeDefined();
      const customizeItem = viewMenu?.submenu?.find((sub) => sub.label === 'Customize Toolbar...');
      expect(customizeItem).toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('builds View menu containing Back and Forward navigation shortcuts', () => {
    const onGoBack = vi.fn();
    const onGoForward = vi.fn();

    const menu = buildAppMenu({
      onNewMessage: vi.fn(),
      onNewPopoutCompose: vi.fn(),
      onGoBack,
      onGoForward,
      canGoBack: true,
      canGoForward: false,
    }) as unknown as Array<{
      label?: string;
      submenu?: Array<{
        label?: string;
        accelerator?: string;
        enabled?: boolean;
        click?: () => void;
      }>;
    }>;

    const viewMenu = menu.find((item) => item.label === 'View');
    expect(viewMenu).toBeDefined();

    const backItem = viewMenu?.submenu?.find((sub) => sub.label === 'Back');
    expect(backItem).toBeDefined();
    expect(backItem?.accelerator).toBe('CmdOrCtrl+[');
    expect(backItem?.enabled).toBe(true);
    backItem?.click?.();
    expect(onGoBack).toHaveBeenCalledTimes(1);

    const forwardItem = viewMenu?.submenu?.find((sub) => sub.label === 'Forward');
    expect(forwardItem).toBeDefined();
    expect(forwardItem?.accelerator).toBe('CmdOrCtrl+]');
    // No history to go forward to, so the item is greyed the way a browser greys it.
    expect(forwardItem?.enabled).toBe(false);
    forwardItem?.click?.();
    expect(onGoForward).toHaveBeenCalledTimes(1);
  });

  it('greys out accounts a Focus Filter disabled, and leaves the rest usable', () => {
    const menu = buildAppMenu({
      accountNames: ['Personal', 'Work', 'University'],
      disabledAccountIndices: [2],
      activeAccountIndex: 0,
    }) as unknown as Array<{
      label?: string;
      submenu?: Array<{ label?: string; enabled?: boolean; type?: string }>;
    }>;

    const accounts = menu.find((item) => item.label === 'Accounts')?.submenu;
    const item = (label: string) => accounts?.find((sub) => sub.label === label);

    // Every account keeps its row -- a disabled one is greyed, never removed,
    // so there is still a visible way back to that mailbox.
    expect(item('Personal')).toBeDefined();
    expect(item('Work')).toBeDefined();
    expect(item('University')).toBeDefined();

    expect(item('University')?.enabled).toBe(false);
    expect(item('Personal')?.enabled).toBe(true);
    expect(item('Work')?.enabled).toBe(true);
  });

  it('leaves every account selectable when nothing is disabled', () => {
    const menu = buildAppMenu({
      accountNames: ['Personal', 'Work'],
      activeAccountIndex: 0,
    }) as unknown as Array<{
      label?: string;
      submenu?: Array<{ label?: string; enabled?: boolean }>;
    }>;

    const accounts = menu.find((item) => item.label === 'Accounts')?.submenu;
    expect(accounts?.find((s) => s.label === 'Personal')?.enabled).toBe(true);
    expect(accounts?.find((s) => s.label === 'Work')?.enabled).toBe(true);
  });

  it('keeps the Accounts menu to the switcher alone', () => {
    const menu = buildAppMenu({
      accountNames: ['Personal', 'Work'],
      activeAccountIndex: 0,
    }) as unknown as Array<{
      label?: string;
      submenu?: Array<{ label?: string; type?: string }>;
    }>;

    const accounts = menu.find((item) => item.label === 'Accounts')?.submenu ?? [];

    // Resetting a session is the settings window's Accounts tab, where the row
    // under the cursor is the one acted on; nothing in the menu should offer it.
    expect(accounts.filter((sub) => sub.type !== 'radio' && sub.type !== 'separator')).toEqual([]);
    expect(accounts.some((sub) => sub.label?.includes('Reset'))).toBe(false);
  });

  it('builds Edit menu with Find submenu and shortcuts', () => {
    const onFindInPage = vi.fn();
    const onFindNext = vi.fn();
    const onFindPrevious = vi.fn();
    const onSearchMailbox = vi.fn();

    const menu = buildAppMenu({
      onNewMessage: vi.fn(),
      onNewPopoutCompose: vi.fn(),
      onFindInPage,
      onFindNext,
      onFindPrevious,
      onSearchMailbox,
    }) as unknown as Array<{
      label?: string;
      submenu?: Array<{
        label?: string;
        submenu?: Array<{ label?: string; accelerator?: string; click?: () => void }>;
      }>;
    }>;

    const editMenu = menu.find((item) => item.label === 'Edit');
    expect(editMenu).toBeDefined();

    const findItem = editMenu?.submenu?.find((sub) => sub.label === 'Find');
    expect(findItem).toBeDefined();

    const findInPage = findItem?.submenu?.find((sub) => sub.label === 'Find in Page…');
    expect(findInPage?.accelerator).toBe('CmdOrCtrl+F');
    findInPage?.click?.();
    expect(onFindInPage).toHaveBeenCalledTimes(1);

    const findNext = findItem?.submenu?.find((sub) => sub.label === 'Find Next');
    expect(findNext?.accelerator).toBe('CmdOrCtrl+G');
    findNext?.click?.();
    expect(onFindNext).toHaveBeenCalledTimes(1);

    const findPrev = findItem?.submenu?.find((sub) => sub.label === 'Find Previous');
    expect(findPrev?.accelerator).toBe('CmdOrCtrl+Shift+G');
    findPrev?.click?.();
    expect(onFindPrevious).toHaveBeenCalledTimes(1);

    const searchMailbox = findItem?.submenu?.find((sub) => sub.label === 'Search Mailbox…');
    expect(searchMailbox?.accelerator).toBe('Alt+CmdOrCtrl+F');
    searchMailbox?.click?.();
    expect(onSearchMailbox).toHaveBeenCalledTimes(1);
  });
});

describe('the Help menu', () => {
  type Template = Array<{
    label?: string;
    role?: string;
    submenu?: Array<{ label?: string; enabled?: boolean; click?: () => void }>;
  }>;

  function helpMenu(onRevealLogs?: () => void, onCollectDiagnostics?: () => void) {
    const menu = buildAppMenu({
      onNewMessage: vi.fn(),
      onNewPopoutCompose: vi.fn(),
      onRevealLogs,
      onCollectDiagnostics,
    }) as unknown as Template;
    return menu.find((item) => item.role === 'help');
  }

  it('exists, so there is somewhere to reach the logs from', () => {
    expect(helpMenu(vi.fn())).toBeDefined();
  });

  it('uses the help role rather than a plain label', () => {
    // AppKit only adds its search field, and only forces the menu last, for the
    // menu it recognises by role.
    const menu = buildAppMenu({
      onNewMessage: vi.fn(),
      onNewPopoutCompose: vi.fn(),
      onRevealLogs: vi.fn(),
    }) as unknown as Template;
    expect(menu.find((item) => item.label === 'Help' && !item.role)).toBeUndefined();
    expect(menu.at(-1)?.role).toBe('help');
  });

  it('offers Magimail Help opening the user guide', () => {
    const item = helpMenu(vi.fn())?.submenu?.find((sub) => sub.label === 'Magimail Help');
    expect(item).toBeDefined();

    item?.click?.();
    expect(shell.openExternal).toHaveBeenCalledWith(
      'https://macmagic.app/help/magimail/getting-started',
    );
  });

  it('offers Gmail Help opening the help centre', () => {
    const item = helpMenu(vi.fn())?.submenu?.find((sub) => sub.label === 'Gmail Help');
    expect(item).toBeDefined();

    item?.click?.();
    expect(shell.openExternal).toHaveBeenCalledWith('https://support.google.com/mail');
  });

  it('links the repo from the Help menu', () => {
    helpMenu(vi.fn())
      ?.submenu?.find((sub) => sub.label === 'GitHub Repository')
      ?.click?.();
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/alxhslm/magic-apps');
  });

  it('offers Collect Diagnostics… in Help menu', () => {
    const item = helpMenu(vi.fn(), vi.fn())?.submenu?.find(
      (sub) => sub.label === 'Collect Diagnostics…',
    );
    expect(item).toBeDefined();
    expect(item?.enabled).toBe(true);
  });

  it('invokes the diagnostics handler when clicked', () => {
    const onCollectDiagnostics = vi.fn();
    helpMenu(vi.fn(), onCollectDiagnostics)
      ?.submenu?.find((sub) => sub.label === 'Collect Diagnostics…')
      ?.click?.();
    expect(onCollectDiagnostics).toHaveBeenCalledTimes(1);
  });

  it('greys out Collect Diagnostics… when onCollectDiagnostics is omitted', () => {
    const item = helpMenu(vi.fn(), undefined)?.submenu?.find(
      (sub) => sub.label === 'Collect Diagnostics…',
    );
    expect(item?.enabled).toBe(false);
  });

  it('offers Reveal Logs in Finder', () => {
    const item = helpMenu(vi.fn())?.submenu?.find((sub) => sub.label === 'Reveal Logs in Finder');
    expect(item).toBeDefined();
    expect(item?.enabled).toBe(true);
  });

  it('invokes the handler when clicked', () => {
    const onRevealLogs = vi.fn();
    helpMenu(onRevealLogs)
      ?.submenu?.find((sub) => sub.label === 'Reveal Logs in Finder')
      ?.click?.();
    expect(onRevealLogs).toHaveBeenCalledTimes(1);
  });

  it('greys the item out rather than offering a dead command', () => {
    const item = helpMenu(undefined)?.submenu?.find((sub) => sub.label === 'Reveal Logs in Finder');
    expect(item?.enabled).toBe(false);
  });

  it('offers About Magimail opening the about panel', async () => {
    const item = helpMenu(vi.fn())?.submenu?.find((sub) => sub.label === 'About Magimail');
    expect(item).toBeDefined();

    item?.click?.();
    const { app } = vi.mocked(await import('electron'));
    expect(app.showAboutPanel).toHaveBeenCalledTimes(1);
  });
});

describe('Remove All App Data and Quit…', () => {
  type Template = Array<{
    label?: string;
    role?: string;
    type?: string;
    click?: () => void;
    submenu?: Template[];
  }>;

  const LABEL = 'Remove All App Data and Quit…';

  // The app menu is macOS-only, but the suite runs on Linux too: force darwin here
  // or the item is absent and the test passes for the wrong reason.
  const originalPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  function appSubmenu(onRemoveAllData?: () => void): Template[] {
    const menu = buildAppMenu({
      onNewMessage: vi.fn(),
      onNewPopoutCompose: vi.fn(),
      onRemoveAllData,
    }) as unknown as Template;
    return menu.find((item) => item.label === 'Magimail')?.submenu ?? [];
  }

  it('sits on its own, immediately above Quit', () => {
    const submenu = appSubmenu(vi.fn());
    const index = submenu.findIndex((item) => item.label === LABEL);

    expect(index).toBeGreaterThan(-1);
    expect(submenu[index - 1]?.type).toBe('separator');
    expect(submenu[index + 1]?.type).toBe('separator');
    expect(submenu[index + 2]?.role).toBe('quit');
  });

  it('invokes the handler when clicked', () => {
    const onRemoveAllData = vi.fn();
    appSubmenu(onRemoveAllData)
      .find((item) => item.label === LABEL)
      ?.click?.();

    expect(onRemoveAllData).toHaveBeenCalledTimes(1);
  });

  it('is left off the menu on a run that is not the installed app', () => {
    // Absent rather than disabled: on a `--profile` or demo run the item would
    // delete the default install's files, which are not this run's to remove.
    expect(appSubmenu(undefined).some((item) => item.label === LABEL)).toBe(false);
  });
});
