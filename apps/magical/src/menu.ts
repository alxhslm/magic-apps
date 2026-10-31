import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron';
import { GITHUB_REPOSITORY_URL, MAGICAL_HELP_URL } from '@magimail/core';
import { CALENDAR_HELP_URL } from './constants.js';
import { uiString } from './strings.js';

export interface AppMenuOptions {
  accounts: { id: string; name: string; disabledByFocus?: boolean }[];
  activeAccountId: string;
  onSwitchAccount: (index: number) => void;
  onOpenSettings: () => void;
  onReload: () => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  /** Whether the active account has anywhere to go back or forward to. */
  canGoBack?: boolean;
  canGoForward?: boolean;
  onNewEvent?: () => void;
  onImportFile?: () => void;
  onSetAsDefault?: () => void;
  onFindInPage?: () => void;
  onFindNext?: () => void;
  onFindPrevious?: () => void;
  onSearchCalendar?: () => void;
  onSearch?: () => void;
  onCustomizeToolbar?: () => void;
  onToggleSidebar?: () => void;
  currentTheme: 'system' | 'light' | 'dark';
  onSetTheme: (theme: 'system' | 'light' | 'dark') => void;
  onCollectDiagnostics?: () => void;
  onRevealLogs?: () => void;
  /**
   * Removes everything the install wrote, then quits. Absent on a run that is not
   * the installed app, where the item would delete another profile's files.
   */
  onRemoveAllData?: () => void;
}

/**
 * Deliberately thin.
 *
 * Google Calendar owns its own single-key shortcuts — `D`, `W`, `M`, `A`, `T`,
 * `C`, `/` — and they keep working because nothing here claims them. Adding
 * Cmd-equivalents for navigation is Phase 2's job, alongside the toolbar that
 * gives them a visible home.
 *
 * The Accounts menu is the canonical switcher until that toolbar exists: macOS
 * renders the key equivalents itself, and a radio group is a real AppKit
 * control rather than a drawn lookalike.
 */
export function buildAppMenu({
  accounts,
  activeAccountId,
  onSwitchAccount,
  onOpenSettings,
  onReload,
  onGoBack,
  onGoForward,
  canGoBack = true,
  canGoForward = true,
  onNewEvent,
  onImportFile,
  onSetAsDefault,
  onFindInPage,
  onFindNext,
  onFindPrevious,
  onSearchCalendar,
  onSearch,
  onCustomizeToolbar,
  onToggleSidebar,
  currentTheme,
  onSetTheme,
  onCollectDiagnostics,
  onRevealLogs,
  onRemoveAllData,
}: AppMenuOptions): Menu {
  const themeItem = (
    label: string,
    theme: 'system' | 'light' | 'dark',
  ): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: currentTheme === theme,
    click: () => onSetTheme(theme),
  });

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        // Above Settings, where Magimail puts its own. Always present and always
        // answering, even when Magical already holds the type: a menu item the user
        // chose deliberately has to say something back.
        {
          label: uiString('menu.setAsDefault'),
          click: () => onSetAsDefault?.(),
        },
        { label: uiString('menu.settings'), accelerator: 'CmdOrCtrl+,', click: onOpenSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        // Its own group, with the separator AppKit keeps above Quit below it: this
        // item deletes the install's own files, and it does not belong in the same
        // run as Hide and Services.
        ...(onRemoveAllData
          ? [
              { type: 'separator' as const },
              {
                label: uiString('menu.app.removeAllData'),
                click: () => onRemoveAllData(),
              },
            ]
          : []),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: uiString('menu.file'),
      submenu: [
        {
          label: uiString('menu.file.newEvent'),
          accelerator: 'CmdOrCtrl+N',
          click: () => onNewEvent?.(),
        },
        // The same import a double-clicked file gets, for when Magical is already
        // open and the file is not in front of you. Where Calendar and Fantastical
        // both put it.
        {
          label: uiString('menu.file.importCalendarFile'),
          accelerator: 'Shift+CmdOrCtrl+I',
          click: () => onImportFile?.(),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: uiString('menu.edit'),
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: uiString('menu.edit.find'),
          submenu: [
            {
              label: uiString('menu.edit.find.findInPage'),
              accelerator: 'CmdOrCtrl+F',
              click: () => onFindInPage?.(),
            },
            {
              label: uiString('menu.edit.find.findNext'),
              accelerator: 'CmdOrCtrl+G',
              click: () => onFindNext?.(),
            },
            {
              label: uiString('menu.edit.find.findPrevious'),
              accelerator: 'CmdOrCtrl+Shift+G',
              click: () => onFindPrevious?.(),
            },
            { type: 'separator' },
            {
              label: uiString('menu.edit.find.searchCalendar'),
              accelerator: 'Alt+CmdOrCtrl+F',
              click: () => (onSearchCalendar ?? onSearch)?.(),
            },
          ],
        },
      ],
    },
    {
      label: uiString('menu.view'),
      submenu: [
        {
          label: uiString('menu.view.back'),
          accelerator: 'CmdOrCtrl+[',
          enabled: canGoBack,
          click: () => onGoBack?.(),
        },
        {
          label: uiString('menu.view.forward'),
          accelerator: 'CmdOrCtrl+]',
          enabled: canGoForward,
          click: () => onGoForward?.(),
        },
        { type: 'separator' },
        {
          label: uiString('menu.view.reloadCalendar'),
          accelerator: 'CmdOrCtrl+R',
          click: onReload,
        },
        {
          label: uiString('menu.view.toggleSidebar'),
          accelerator: 'CmdOrCtrl+\\',
          click: () => onToggleSidebar?.(),
        },
        { type: 'separator' },
        {
          label: uiString('menu.view.appearance'),
          submenu: [
            themeItem(uiString('menu.view.appearance.system'), 'system'),
            themeItem(uiString('menu.view.appearance.light'), 'light'),
            themeItem(uiString('menu.view.appearance.dark'), 'dark'),
          ],
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(onCustomizeToolbar
          ? [
              { type: 'separator' as const },
              {
                label: uiString('menu.view.customizeToolbar'),
                click: () => onCustomizeToolbar(),
              },
            ]
          : []),
      ],
    },
    {
      label: uiString('menu.accounts'),
      submenu: [
        // Radio rather than plain commands, so the menu shows which account is
        // being viewed and not just which ones exist. Electron owns the
        // exclusivity within the run of items.
        //
        // Switching only. Resetting a session and removing an account belong to the
        // settings window's Accounts tab, as they do in Magimail — a second surface
        // for them would be a second thing to keep in step.
        // A Focus filter can block an account rather than merely quieten it, and such an
        // account stays listed. `enabled: false` is what greys it: AppKit draws the item
        // itself, so the reason is on screen rather than the row simply being missing.
        ...accounts.map<MenuItemConstructorOptions>((account, index) => ({
          label: account.name,
          type: 'radio',
          checked: account.id === activeAccountId,
          enabled: !account.disabledByFocus,
          accelerator: index < 9 ? `CmdOrCtrl+${index + 1}` : undefined,
          click: () => onSwitchAccount(index),
        })),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: uiString('menu.help.magicalHelp'),
          click: () => shell.openExternal(MAGICAL_HELP_URL),
        },
        {
          label: uiString('menu.help.googleCalendarHelp'),
          click: () => shell.openExternal(CALENDAR_HELP_URL),
        },
        { type: 'separator' },
        {
          label: uiString('menu.help.collectDiagnostics'),
          enabled: Boolean(onCollectDiagnostics),
          click: () => onCollectDiagnostics?.(),
        },
        {
          label: uiString('menu.help.revealLogs'),
          enabled: Boolean(onRevealLogs),
          click: () => onRevealLogs?.(),
        },
        { type: 'separator' },
        {
          label: uiString('menu.help.githubRepository'),
          click: () => shell.openExternal(GITHUB_REPOSITORY_URL),
        },
        {
          label: uiString('menu.help.about'),
          click: () => app.showAboutPanel(),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
