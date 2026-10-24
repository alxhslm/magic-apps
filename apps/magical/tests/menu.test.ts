import { describe, it, expect, vi } from 'vitest';
import { shell } from 'electron';
import { buildAppMenu, type AppMenuOptions } from '../src/menu.js';

vi.mock('electron', () => ({
  app: {
    name: 'Magical',
    showAboutPanel: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn((template) => template),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

type TemplateItem = {
  label?: string;
  role?: string;
  type?: string;
  enabled?: boolean;
  click?: () => void;
  submenu?: TemplateItem[];
};

function defaultOptions(overrides: Partial<AppMenuOptions> = {}): AppMenuOptions {
  return {
    accounts: [
      { id: 'acc_1', name: 'Personal' },
      { id: 'acc_2', name: 'Work' },
    ],
    activeAccountId: 'acc_1',
    onSwitchAccount: vi.fn(),
    onOpenSettings: vi.fn(),
    onReload: vi.fn(),
    currentTheme: 'system',
    onSetTheme: vi.fn(),
    ...overrides,
  };
}

describe('buildAppMenu for Magical', () => {
  it('builds application menu with help submenu', () => {
    const menu = buildAppMenu(defaultOptions()) as unknown as TemplateItem[];
    const helpMenu = menu.find((item) => item.role === 'help');
    expect(helpMenu).toBeDefined();
    expect(helpMenu?.submenu).toBeDefined();
  });

  it('offers Magical Help opening the user guide', () => {
    const menu = buildAppMenu(defaultOptions()) as unknown as TemplateItem[];
    const helpMenu = menu.find((item) => item.role === 'help');
    const item = helpMenu?.submenu?.find((sub) => sub.label === 'Magical Help');

    expect(item).toBeDefined();

    item?.click?.();
    expect(shell.openExternal).toHaveBeenCalledWith(
      'https://macmagic.app/help/magical/getting-started',
    );
  });

  it('points Google Calendar Help at the help centre, not the calendar itself', () => {
    const menu = buildAppMenu(defaultOptions()) as unknown as TemplateItem[];
    const helpMenu = menu.find((item) => item.role === 'help');
    const item = helpMenu?.submenu?.find((sub) => sub.label === 'Google Calendar Help');

    expect(item).toBeDefined();

    item?.click?.();
    expect(shell.openExternal).toHaveBeenCalledWith('https://support.google.com/calendar');
  });

  it('links the repo from Help', () => {
    const menu = buildAppMenu(defaultOptions()) as unknown as TemplateItem[];
    const helpMenu = menu.find((item) => item.role === 'help');

    helpMenu?.submenu?.find((sub) => sub.label === 'GitHub Repository')?.click?.();
    expect(shell.openExternal).toHaveBeenCalledWith('https://github.com/alxhslm/magic-apps');
  });

  it('offers Collect Diagnostics… when onCollectDiagnostics is provided', () => {
    const onCollectDiagnostics = vi.fn();
    const menu = buildAppMenu(
      defaultOptions({ onCollectDiagnostics }),
    ) as unknown as TemplateItem[];
    const helpMenu = menu.find((item) => item.role === 'help');
    const item = helpMenu?.submenu?.find((sub) => sub.label === 'Collect Diagnostics…');

    expect(item).toBeDefined();
    expect(item?.enabled).toBe(true);

    item?.click?.();
    expect(onCollectDiagnostics).toHaveBeenCalledTimes(1);
  });

  it('disables Collect Diagnostics… when onCollectDiagnostics is omitted', () => {
    const menu = buildAppMenu(
      defaultOptions({ onCollectDiagnostics: undefined }),
    ) as unknown as TemplateItem[];
    const helpMenu = menu.find((item) => item.role === 'help');
    const item = helpMenu?.submenu?.find((sub) => sub.label === 'Collect Diagnostics…');

    expect(item).toBeDefined();
    expect(item?.enabled).toBe(false);
  });

  it('offers Reveal Logs in Finder when onRevealLogs is provided', () => {
    const onRevealLogs = vi.fn();
    const menu = buildAppMenu(defaultOptions({ onRevealLogs })) as unknown as TemplateItem[];
    const helpMenu = menu.find((item) => item.role === 'help');
    const item = helpMenu?.submenu?.find((sub) => sub.label === 'Reveal Logs in Finder');

    expect(item).toBeDefined();
    expect(item?.enabled).toBe(true);

    item?.click?.();
    expect(onRevealLogs).toHaveBeenCalledTimes(1);
  });

  it('offers About Magical opening the about panel', async () => {
    const menu = buildAppMenu(defaultOptions()) as unknown as TemplateItem[];
    const helpMenu = menu.find((item) => item.role === 'help');
    const item = helpMenu?.submenu?.find((sub) => sub.label === 'About Magical');

    expect(item).toBeDefined();

    item?.click?.();
    const { app } = vi.mocked(await import('electron'));
    expect(app.showAboutPanel).toHaveBeenCalledTimes(1);
  });

  it('offers Import Calendar File in the File menu', () => {
    const onImportFile = vi.fn();
    const menu = buildAppMenu(defaultOptions({ onImportFile })) as unknown as TemplateItem[];
    const fileMenu = menu.find((item) => item.label === 'File');
    const item = fileMenu?.submenu?.find((sub) => sub.label === 'Import Calendar File…');

    expect(item).toBeDefined();

    item?.click?.();
    expect(onImportFile).toHaveBeenCalledTimes(1);
  });

  it('leaves Import Calendar File inert rather than absent when nothing handles it', () => {
    const menu = buildAppMenu(
      defaultOptions({ onImportFile: undefined }),
    ) as unknown as TemplateItem[];
    const fileMenu = menu.find((item) => item.label === 'File');
    const item = fileMenu?.submenu?.find((sub) => sub.label === 'Import Calendar File…');

    expect(item).toBeDefined();
    expect(() => item?.click?.()).not.toThrow();
  });

  it('offers Set as Default in the app menu, where Magimail puts its own', () => {
    const onSetAsDefault = vi.fn();
    const menu = buildAppMenu(defaultOptions({ onSetAsDefault })) as unknown as TemplateItem[];
    const appMenu = menu.find((item) => item.label === 'Magical');
    const item = appMenu?.submenu?.find((sub) => sub.label?.startsWith('Set Magical as Default'));

    expect(item).toBeDefined();

    item?.click?.();
    expect(onSetAsDefault).toHaveBeenCalledTimes(1);
  });

  it('disables Reveal Logs in Finder when onRevealLogs is omitted', () => {
    const menu = buildAppMenu(
      defaultOptions({ onRevealLogs: undefined }),
    ) as unknown as TemplateItem[];
    const helpMenu = menu.find((item) => item.role === 'help');
    const item = helpMenu?.submenu?.find((sub) => sub.label === 'Reveal Logs in Finder');

    expect(item).toBeDefined();
    expect(item?.enabled).toBe(false);
  });

  it('keeps the Accounts menu to the switcher alone', () => {
    const menu = buildAppMenu(defaultOptions()) as unknown as TemplateItem[];
    const accounts = menu.find((item) => item.label === 'Accounts')?.submenu ?? [];

    // Resetting a session is the settings window's Accounts tab, where the row
    // under the cursor is the one acted on; nothing in the menu should offer it.
    expect(accounts.filter((sub) => sub.type !== 'radio' && sub.type !== 'separator')).toEqual([]);
    expect(accounts.some((sub) => sub.label?.includes('Reset'))).toBe(false);
  });

  it('offers Remove All App Data and Quit… on its own, immediately above Quit', () => {
    const menu = buildAppMenu(
      defaultOptions({ onRemoveAllData: vi.fn() }),
    ) as unknown as TemplateItem[];
    const submenu = menu.find((item) => item.label === 'Magical')?.submenu ?? [];
    const index = submenu.findIndex((sub) => sub.label === 'Remove All App Data and Quit…');

    expect(index).toBeGreaterThan(-1);
    expect(submenu[index - 1]?.type).toBe('separator');
    expect(submenu[index + 1]?.type).toBe('separator');
    expect(submenu[index + 2]?.role).toBe('quit');
  });

  it('invokes the removal handler when clicked', () => {
    const onRemoveAllData = vi.fn();
    const menu = buildAppMenu(defaultOptions({ onRemoveAllData })) as unknown as TemplateItem[];
    menu
      .find((item) => item.label === 'Magical')
      ?.submenu?.find((sub) => sub.label === 'Remove All App Data and Quit…')
      ?.click?.();

    expect(onRemoveAllData).toHaveBeenCalledTimes(1);
  });

  it('is left off the menu on a run that is not the installed app', () => {
    // Absent rather than disabled: on a `--profile` or demo run the item would
    // delete the default install's files, which are not this run's to remove.
    const menu = buildAppMenu(defaultOptions()) as unknown as TemplateItem[];
    const submenu = menu.find((item) => item.label === 'Magical')?.submenu ?? [];

    expect(submenu.some((sub) => sub.label === 'Remove All App Data and Quit…')).toBe(false);
  });

  it('builds View menu containing Back and Forward navigation shortcuts', () => {
    const onGoBack = vi.fn();
    const onGoForward = vi.fn();
    const menu = buildAppMenu(
      defaultOptions({ onGoBack, onGoForward, canGoBack: true, canGoForward: false }),
    ) as unknown as TemplateItem[];

    const viewMenu = menu.find((item) => item.label === 'View');
    expect(viewMenu).toBeDefined();

    const backItem = viewMenu?.submenu?.find((sub) => sub.label === 'Back') as unknown as {
      accelerator?: string;
      enabled?: boolean;
      click?: () => void;
    };
    expect(backItem).toBeDefined();
    expect(backItem.accelerator).toBe('CmdOrCtrl+[');
    expect(backItem.enabled).toBe(true);
    backItem.click?.();
    expect(onGoBack).toHaveBeenCalledTimes(1);

    const forwardItem = viewMenu?.submenu?.find((sub) => sub.label === 'Forward') as unknown as {
      accelerator?: string;
      enabled?: boolean;
      click?: () => void;
    };
    expect(forwardItem).toBeDefined();
    expect(forwardItem.accelerator).toBe('CmdOrCtrl+]');
    // No history to go forward to, so the item is greyed the way a browser greys it.
    expect(forwardItem.enabled).toBe(false);
    forwardItem.click?.();
    expect(onGoForward).toHaveBeenCalledTimes(1);
  });

  it('builds Edit menu with Find submenu and shortcuts', () => {
    const onFindInPage = vi.fn();
    const onFindNext = vi.fn();
    const onFindPrevious = vi.fn();
    const onSearchCalendar = vi.fn();

    const menu = buildAppMenu(
      defaultOptions({
        onFindInPage,
        onFindNext,
        onFindPrevious,
        onSearchCalendar,
      }),
    ) as unknown as TemplateItem[];

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

    const searchCal = findItem?.submenu?.find((sub) => sub.label === 'Search Calendar…');
    expect(searchCal?.accelerator).toBe('Alt+CmdOrCtrl+F');
    searchCal?.click?.();
    expect(onSearchCalendar).toHaveBeenCalledTimes(1);
  });
});
