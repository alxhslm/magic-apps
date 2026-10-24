import { app, Menu, MenuItemConstructorOptions, shell } from 'electron';
import { GITHUB_REPOSITORY_URL, MAGIMAIL_HELP_URL } from '@magimail/core';
import { GMAIL_HELP_URL } from './constants.js';
import { uiString } from './strings.js';

export interface AppMenuOptions {
  onNewMessage: () => void;
  onNewPopoutCompose: () => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  /** Whether the active account has anywhere to go back or forward to. */
  canGoBack?: boolean;
  canGoForward?: boolean;
  onSwitchAccount?: (index: number) => void;
  onReloadActive?: () => void;
  onFindInPage?: () => void;
  onFindNext?: () => void;
  onFindPrevious?: () => void;
  onSearchMailbox?: () => void;
  onSearch?: () => void;
  onPrint?: () => void;
  onExportPdf?: () => void;
  onCopyLink?: () => void;
  onShareLink?: () => void;
  onSharePdf?: () => void;
  isMessageSelected?: boolean;
  currentTheme?: 'system' | 'light' | 'dark';
  onSetTheme?: (theme: 'system' | 'light' | 'dark') => void;
  onSetAsDefaultEmailReader?: () => void;
  onOpenSettings?: () => void;
  onCustomizeToolbar?: () => void;
  onCollectDiagnostics?: () => void;
  onRevealLogs?: () => void;
  /**
   * Removes everything the install wrote, then quits. Absent on a run that is not
   * the installed app, where the item would delete another profile's files.
   */
  onRemoveAllData?: () => void;
  accountNames?: string[];
  /**
   * Indices of accounts a Focus Filter has disabled. They keep their place in
   * the menu -- removing a row would leave no way back to that mailbox -- but
   * are greyed and unselectable. AppKit draws the grey for a disabled item, so
   * this needs no styling of our own.
   */
  disabledAccountIndices?: number[];
  activeAccountIndex?: number;
}

export function buildAppMenu({
  onNewMessage,
  onNewPopoutCompose,
  onGoBack,
  onGoForward,
  canGoBack = true,
  canGoForward = true,
  onSwitchAccount,
  onReloadActive,
  onFindInPage,
  onFindNext,
  onFindPrevious,
  onSearchMailbox,
  onSearch,
  onPrint,
  onExportPdf,
  onCopyLink,
  onShareLink,
  onSharePdf,
  isMessageSelected = true,
  currentTheme = 'system',
  onSetTheme,
  onSetAsDefaultEmailReader,
  onOpenSettings,
  onCustomizeToolbar,
  onCollectDiagnostics,
  onRevealLogs,
  onRemoveAllData,
  accountNames = [],
  disabledAccountIndices = [],
  activeAccountIndex,
}: AppMenuOptions): Menu {
  const isMac = process.platform === 'darwin';

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: uiString('menu.setAsDefaultEmailReader'),
                click: () => onSetAsDefaultEmailReader?.(),
              },
              {
                label: uiString('menu.preferences'),
                accelerator: 'CmdOrCtrl+,',
                click: () => onOpenSettings?.(),
              },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              // Its own group, with the separator AppKit keeps above Quit below it:
              // this item deletes the install's own files, and it does not belong
              // in the same run as Hide and Services.
              ...(onRemoveAllData
                ? [
                    { type: 'separator' as const },
                    {
                      label: uiString('menu.app.removeAllData'),
                      click: () => onRemoveAllData(),
                    },
                  ]
                : []),
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: uiString('menu.file'),
      submenu: [
        {
          label: uiString('menu.file.newMessage'),
          accelerator: 'CmdOrCtrl+N',
          click: onNewMessage,
        },
        {
          label: uiString('menu.file.newDetachedCompose'),
          accelerator: 'CmdOrCtrl+Shift+N',
          click: onNewPopoutCompose,
        },
        { type: 'separator' },
        {
          label: uiString('menu.file.share'),
          submenu: [
            {
              label: uiString('menu.file.share.copyLink'),
              enabled: isMessageSelected,
              click: () => onCopyLink?.(),
            },
            {
              label: uiString('menu.file.share.shareLink'),
              enabled: isMessageSelected,
              click: () => onShareLink?.(),
            },
            {
              label: uiString('menu.file.share.shareAsPdf'),
              enabled: isMessageSelected,
              click: () => onSharePdf?.(),
            },
          ],
        },
        { type: 'separator' },
        {
          label: uiString('menu.file.exportAsPdf'),
          enabled: isMessageSelected,
          click: () => onExportPdf?.(),
        },
        {
          label: uiString('menu.file.print'),
          accelerator: 'CmdOrCtrl+P',
          enabled: isMessageSelected,
          click: () => onPrint?.(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: uiString('menu.accounts'),
      submenu: [
        // Radio rather than plain commands, so the menu shows which account is
        // being viewed and not just which ones exist. Electron owns the
        // exclusivity within the run of items.
        //
        // Switching only. Resetting a session and removing an account live on the
        // settings window's Accounts tab, where the row being acted on is the one
        // under the cursor — a second surface for them would be a second thing to
        // keep in step.
        ...accountNames.map((name, index) => ({
          label: name,
          type: 'radio' as const,
          checked: index === activeAccountIndex,
          enabled: !disabledAccountIndices.includes(index),
          accelerator: index < 9 ? `CmdOrCtrl+${index + 1}` : undefined,
          click: () => onSwitchAccount?.(index),
        })),
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
              label: uiString('menu.edit.find.searchMailbox'),
              accelerator: 'Alt+CmdOrCtrl+F',
              click: () => (onSearchMailbox ?? onSearch)?.(),
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
          label: uiString('menu.view.theme'),
          submenu: [
            {
              label: uiString('menu.view.theme.system'),
              type: 'radio' as const,
              checked: currentTheme === 'system',
              click: () => onSetTheme?.('system'),
            },
            {
              label: uiString('menu.view.theme.light'),
              type: 'radio' as const,
              checked: currentTheme === 'light',
              click: () => onSetTheme?.('light'),
            },
            {
              label: uiString('menu.view.theme.dark'),
              type: 'radio' as const,
              checked: currentTheme === 'dark',
              click: () => onSetTheme?.('dark'),
            },
          ],
        },
        { type: 'separator' },
        {
          label: uiString('menu.view.reload'),
          accelerator: 'CmdOrCtrl+R',
          click: () => onReloadActive?.(),
        },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isMac && onCustomizeToolbar
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
      label: uiString('menu.window'),
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [
              { type: 'separator' as const },
              { role: 'front' as const },
              { type: 'separator' as const },
              { role: 'window' as const },
            ]
          : [{ role: 'close' as const }]),
      ],
    },
    // `role: 'help'` rather than a plain label: AppKit puts its own search
    // field in the menu it recognises as Help, and places it last regardless of
    // where the template puts it.
    {
      role: 'help',
      submenu: [
        {
          label: uiString('menu.help.magimailHelp'),
          click: () => shell.openExternal(MAGIMAIL_HELP_URL),
        },
        {
          label: uiString('menu.help.gmailHelp'),
          click: () => shell.openExternal(GMAIL_HELP_URL),
        },
        { type: 'separator' },
        {
          label: uiString('menu.help.collectDiagnostics'),
          enabled: Boolean(onCollectDiagnostics),
          click: () => onCollectDiagnostics?.(),
        },
        {
          // Reveals the folder, not the file. Archived logs sit beside the live
          // one, and a report wants the set -- there is no telling in advance
          // which rotation holds the failure.
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
