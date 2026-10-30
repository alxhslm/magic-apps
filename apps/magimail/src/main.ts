import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  screen,
  session,
  shell,
  type Rectangle,
} from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  prereleaseBuildExpiredMessage,
  calculateAggregateUnread,
  configureSecretFiles,
  createMainWindowOptions,
  configureGoogleSession,
  DEFAULT_CLEAN_USER_AGENT,
  FindInPageController,
  getGoogleSurfaceColor,
  isPrereleaseBuildExpired,
  isDemoMode,
  openWindowForAction,
  resolveUserDataPath,
  WEBSITE_URL,
  type AccountConfig,
  type WindowActionTarget,
  viewIsAlive,
} from '@magimail/core';
import { DEFAULT_PARTITION, IPC_CHANNELS } from './constants.js';
import {
  createLogger,
  initLogging,
  installCrashHandlers,
  logDirectory,
  logDisplayEnvironment,
  logStartupBanner,
  redactUrl,
} from '@magimail/core/logger';
import { buildAppMenu } from './menu.js';
import { setUiLocale, uiString } from './strings.js';
import { AccountsManager, asThreadAction, TRIAGE_ACTIONS } from './accounts-manager.js';
import { updateDockBadge, refreshDockBadge } from './dock.js';
import { localCacheKey } from './native-addon.js';
import { accountIdFromLink } from './protocol-links.js';
import { type ThreadActionOutcome, type TriageAction } from './thread-actions/index.js';

// Replaced by tsup at build time with the Unix milliseconds the bundle was
// compiled at; see `prerelease-build-expiry.ts` in @magimail/core.
declare const __BUILD_TIMESTAMP__: number;

// 1. Ensure stable userData path across dev and production, with support for custom profiles/flags
app.name = 'Magimail';
if (isDemoMode()) {
  // A demo is its own app identity, not just its own userData. Chromium names the
  // keychain item that wraps cookie encryption after the app, so without this a demo
  // shares `Magimail Safe Storage` with the real install. An unpackaged build whose
  // signature that item does not trust can then invalidate the key for every profile at
  // once, demo included. The log directory is pinned back to the real one, so the
  // debugging skills keep reading a single `main.log`.
  const logsPath = app.getPath('logs');
  app.name = 'Magimail-demo';
  app.setPath('logs', logsPath);
}
try {
  const userData = resolveUserDataPath({
    appName: 'Magimail',
    appDataPath: app.getPath('appData'),
  });
  app.setPath('userData', userData);
} catch {
  // Ignore if already set
}
const debugPortArg = process.argv.find(
  (a) => a.startsWith('--debug-port=') || a === '--debug-port',
);
let debugPort: string | null = null;
if (debugPortArg) {
  debugPort = debugPortArg.includes('=') ? debugPortArg.split('=')[1] : '9222';
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

// Before anything that can throw: an unhandled error raised earlier than this
// still reaches stderr, but not the file a user can attach to a report.
initLogging({ isPackaged: app.isPackaged });
logStartupBanner('Magimail', app.getVersion());
installCrashHandlers({
  describeRenderer: (id) => accountsManager?.getAccountIdForWebContentsId(id),
});
const log = createLogger('Main');

/**
 * Refuse to start a packaged pre-release bundle that has outlived its 90-day
 * window, before a window, helper or session exists. Returns true when the app
 * is on its way out and the caller must stop the launch.
 */
async function enforcePrereleaseBuildExpiry(): Promise<boolean> {
  const builtAt = __BUILD_TIMESTAMP__;
  if (
    !isPrereleaseBuildExpired({
      builtAt,
      now: Date.now(),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    })
  ) {
    return false;
  }
  const detail = prereleaseBuildExpiredMessage({ builtAt, version: app.getVersion() }, uiString);
  log.warn(detail);
  await dialog.showMessageBox({
    type: 'warning',
    title: uiString('dialog.expired.title'),
    message: uiString('dialog.expired.message'),
    detail,
    buttons: [uiString('dialog.quit')],
    defaultId: 0,
    noLink: true,
  });
  app.quit();
  return true;
}

// Before the first cache file is read: settings.json, the poller state and the
// theme and default-client preferences are all encrypted under a keychain key
// on a packaged build.
configureSecretFiles({
  isPackaged: app.isPackaged,
  fetchKey: localCacheKey,
  logger: createLogger('SecretFile'),
});

if (debugPort) {
  // Printed rather than left implicit: attaching means finding the page target,
  // and the endpoint is the one thing a debugger client needs to be told.
  log.info(`Remote debugging on http://127.0.0.1:${debugPort} (targets at /json/list)`);
}

import { initCssOverride, watchCssOverride } from './css-override.js';
import { handleMailtoUrl, pickAccount } from './mailto-handler.js';
import { chooseComposeAccount } from './account-picker.js';
import { handleShareUrl } from './share-handler.js';

import { ThemeManager } from './theme-manager.js';
import { DefaultClientManager } from './default-client.js';
import { openSettingsWindow } from './settings.js';
import { buildWidgetCache, writeWidgetCache } from './widget-cache.js';
import { syncExtensionLogs } from './extension-logs.js';
import { handleCollectDiagnostics } from './diagnostics.js';
import { sweepAbandonedShareStaging } from './share-staging.js';
import { loadSettings, saveSetting } from './settings-store.js';
import { applyLaunchAtLogin, reconcileLaunchAtLogin } from './login-item.js';
import {
  spawnHelper,
  sendToHelper,
  onHelperEvent,
  onHelperSpawned,
  killHelper,
} from './swift-helper.js';
import type { MailboxPollEvent } from './mailbox/types.js';
import {
  dispatchNotifications,
  setNotificationClickHandler,
  setNotificationActionHandler,
  handleNotificationEvent,
} from './notification-manager.js';
import {
  createTray,
  updateTrayData,
  destroyTray,
  isTrayCreated,
  restoreTray,
  pushTrayMessages,
  handleTrayEvent,
  RECENT_TRAY_MESSAGES,
  type TrayMessageItem,
} from './menubar-manager.js';
import {
  detachNativeToolbar,
  onNativeToolbarAction,
  runToolbarCustomization,
} from './native-toolbar.js';
import { appGroupContainerPath, reloadNativeWidgets } from './native-widgets.js';
import { canRemoveAllAppData, removeAllAppDataAndQuit } from './remove-all-data.js';
import {
  getActiveFocusFilter,
  setFocusFilter,
  type FocusFilterState,
} from './focus-filter-manager.js';
import {
  openQuickCompose,
  releaseQuickComposeShortcut,
  setQuickComposeShortcut,
} from './quick-compose.js';

let mainWindow: BaseWindow | null = null;
let findInPageController: FindInPageController | null = null;
let isQuitting = false;
/** Set while a replacement window is being built, so recovery cannot recurse. */
let rebuildingWindow = false;
/**
 * Whether the launch pass has finished building the window, the tray and the pollers.
 *
 * A protocol URL that arrives before it is queued (`pendingMailtoUrl`) and replayed by
 * that pass; one that arrives after it is dispatched straight away, building a window if
 * the last one was closed. Without the flag the second case would be queued too and never
 * replayed — the pass it was waiting for has already run.
 */
let initialised = false;
let accountsManager: AccountsManager | null = null;
let themeManager: ThemeManager | null = null;
let defaultClientManager: DefaultClientManager | null = null;
let pendingMailtoUrl: string | null = null;
/**
 * Accounts whose Atom feed a Workspace administrator is refusing.
 *
 * Kept here rather than on `AccountConfig`: it describes this launch's last read, like
 * the offline flag, and a restart re-learns it on the first poll. It is not `needsAuth`,
 * because no credential the user can enter lifts an administrator's block.
 */
const restrictedAccounts = new Set<string>();

/** Magimail's window handles, for the shared action policy. */
const windowActionTarget: WindowActionTarget<AccountsManager> = {
  getWindow: () => mainWindow,
  createWindow: (accountId, options) => {
    mainWindow = createMainWindow(accountId, options);
  },
  focusApp: () => app.focus({ steal: true }),
  getManager: () => accountsManager,
};

/**
 * Snapshot accounts and recent threads for the WidgetKit extension.
 *
 * Messages come from Gmail's local IndexedDB cache rather than the Atom
 * feed's synthetic hoarding list, so the widget sees accurate read/unread
 * state and real categories for every account that has a live renderer. A
 * read that could not run (`null`) falls back to the last good list for that
 * account, and an account that has never answered contributes nothing rather
 * than blanking the snapshot.
 */
const lastWidgetMessages = new Map<string, TrayMessageItem[]>();

async function refreshWidgetCache(accounts: AccountConfig[], totalUnread: number): Promise<void> {
  const messagesByAccount = new Map<string, TrayMessageItem[]>();
  for (const account of accounts) {
    const source = accountsManager?.getMailboxSource(account.id);
    const messages = source ? await source.getRecentMessages(5) : null;
    if (messages && messages.length > 0) {
      lastWidgetMessages.set(account.id, messages);
    }
    messagesByAccount.set(account.id, messages ?? lastWidgetMessages.get(account.id) ?? []);
  }
  const wrote = writeWidgetCache(
    buildWidgetCache(accounts, totalUnread, messagesByAccount),
    appGroupContainerPath,
  );
  if (wrote) reloadNativeWidgets();
}

function handlePollResult(result: MailboxPollEvent): void {
  if (result.status === 'auth_required') {
    restrictedAccounts.delete(result.accountId);
    accountsManager?.setAccountAuthRequired(result.accountId, true);
    const accounts = accountsManager?.getFocusedAccounts() || [];
    updateTrayData(accounts, calculateAggregateUnread(accounts), {
      isRestricted: restrictedAccounts.size > 0,
    });
    return;
  }
  // A tenant policy refusal is neither the network nor a sign-in the user can perform,
  // so it gets its own tray state and clears any stale sign-in flag.
  if (result.status === 'restricted') {
    restrictedAccounts.add(result.accountId);
    accountsManager?.setAccountAuthRequired(result.accountId, false);
    const accounts = accountsManager?.getFocusedAccounts() || [];
    updateTrayData(accounts, calculateAggregateUnread(accounts), {
      isRestricted: true,
    });
    return;
  }
  // A failed poll is the only offline signal once every view is suspended --
  // the renderer's `offline` event needs a live renderer to fire.
  if (result.status === 'network_error') {
    const accounts = accountsManager?.getFocusedAccounts() || [];
    updateTrayData(accounts, calculateAggregateUnread(accounts), {
      isOffline: !net.isOnline(),
      isRestricted: restrictedAccounts.size > 0,
    });
    return;
  }

  // The account's MailboxSource has already applied the ledger's count. This
  // refreshes the surfaces that also show arrivals and message lists.
  if (accountsManager) {
    log.info(`(AtomPoller) Poll ok for ${result.accountId}`);
    restrictedAccounts.delete(result.accountId);

    // Menu bar and widgets show only what the Focus Filter includes -- their
    // job is to pull attention, which is the thing a filter is suppressing.
    const accounts = accountsManager.getFocusedAccounts();
    const totalUnread = calculateAggregateUnread(accounts);
    updateTrayData(accounts, totalUnread, {
      isOffline: !net.isOnline(),
      isRestricted: restrictedAccounts.size > 0,
    });
    refreshWidgetCache(accounts, totalUnread);
  }

  // Dispatch native notifications for new messages
  if (result.newMessages.length > 0) {
    dispatchNotifications(result.accountId, result.newMessages);
  }
}

/**
 * Push one account's recent threads to the helper's popover.
 */
async function sendTrayMessages(accountId: string): Promise<void> {
  const source = accountsManager?.getMailboxSource(accountId);
  if (!source) return;
  const messages = await source.getRecentMessages(RECENT_TRAY_MESSAGES);
  pushTrayMessages(accountId, messages);
}

function updateApplicationMenu(preloadPath: string, isThreadSelected?: boolean): void {
  const currentTheme = themeManager?.getTheme() || 'system';
  const accounts = accountsManager?.getVisibleAccounts() || [];
  const threadOpen = isThreadSelected ?? accountsManager?.isThreadOpenSync() ?? false;

  // Left off the menu entirely -- rather than disabled -- on a run that is not the
  // installed app: the item removes the install's own files, and a `--profile` or
  // demo run would be deleting another profile's accounts.
  const onRemoveAllData = canRemoveAllAppData() ? () => void removeAllAppDataAndQuit() : undefined;

  const menu = buildAppMenu({
    accountNames: accounts.map((a) => a.name),
    disabledAccountIndices: accounts
      .map((a, i) => (accountsManager?.isDisabledByFocus(a.id) ? i : -1))
      .filter((i) => i >= 0),
    activeAccountIndex: accounts.findIndex((a) => a.id === accountsManager?.getActiveAccountId()),
    onNewMessage: () => {
      void composeFromMainWindow();
    },
    onNewPopoutCompose: () => {
      void composeFromMainWindow({ popout: true });
    },
    onGoBack: () => {
      accountsManager?.goBack();
    },
    onGoForward: () => {
      accountsManager?.goForward();
    },
    canGoBack: accountsManager?.canGoBack() ?? false,
    canGoForward: accountsManager?.canGoForward() ?? false,
    onSwitchAccount: (index: number) => {
      accountsManager?.switchToIndex(index);
    },
    onReloadActive: () => {
      reloadMailbox();
    },
    onFindInPage: () => {
      findInPageController?.show();
    },
    onFindNext: () => {
      findInPageController?.findNext();
    },
    onFindPrevious: () => {
      findInPageController?.findPrevious();
    },
    onSearchMailbox: () => {
      accountsManager?.focusSearchInActiveView();
    },
    onSearch: () => {
      accountsManager?.focusSearchInActiveView();
    },
    onPrint: () => {
      accountsManager?.printActiveView();
    },
    onExportPdf: () => {
      accountsManager?.exportActiveThreadToPdf();
    },
    onCopyLink: () => {
      accountsManager?.copyActiveThreadLink();
    },
    onShareLink: () => {
      accountsManager?.shareActiveThreadLink();
    },
    onSharePdf: () => {
      accountsManager?.shareActiveThreadAsPdf();
    },
    isMessageSelected: threadOpen,
    currentTheme,
    onSetTheme: (theme) => {
      themeManager?.setTheme(theme);
      updateApplicationMenu(preloadPath);
    },
    onSetAsDefaultEmailReader: () => {
      defaultClientManager?.promptSetAsDefault(mainWindow);
    },
    onOpenSettings: () => {
      openSettingsWindow(undefined, accountsManager?.getAccounts());
    },
    onCustomizeToolbar: () => {
      runToolbarCustomization();
    },
    onRemoveAllData,
    onCollectDiagnostics: () => {
      void handleCollectDiagnostics(mainWindow, accountsManager);
    },
    onRevealLogs: () => {
      const dir = logDirectory();
      // The directory exists only once something has been written to it, and on
      // a first run that may not have happened yet.
      fs.mkdirSync(dir, { recursive: true });
      syncExtensionLogs(dir);
      shell.openPath(dir).then((err) => {
        if (err) log.error('Could not open the log folder:', err);
      });
    },
  });
  Menu.setApplicationMenu(menu);
}

// Register default protocol handlers. Without `magimail://`, every widget tap,
// notification click and Share extension hand-off stops working at once, and
// the report is "the widget does nothing".
try {
  if (!app.isDefaultProtocolClient('mailto') && !app.setAsDefaultProtocolClient('mailto')) {
    log.warn('macOS refused the mailto: claim; links will open in another client');
  }
  if (!app.isDefaultProtocolClient('magimail') && !app.setAsDefaultProtocolClient('magimail')) {
    log.error('macOS refused the magimail: claim; deep links and widgets will not reach the app');
  }
} catch (err) {
  log.error('Could not register the protocol handlers:', err);
}

/**
 * Compose from the main window, where the active account is on screen. The one
 * place `composeAccountPicker` decides whether to ask; on `active`, its default,
 * this goes straight into the account the user is looking at.
 */
async function composeFromMainWindow({ popout = false } = {}): Promise<void> {
  if (!accountsManager) return;

  const account = await chooseComposeAccount(accountsManager, {
    parentWindow: mainWindow,
    fromMainWindow: true,
  });
  if (!account) return;

  if (account.id !== accountsManager.getActiveAccountId()) {
    accountsManager.switchAccount(account.id);
  }
  if (popout) {
    await accountsManager.triggerComposePopout();
  } else {
    await accountsManager.triggerMailAction('compose', account.id);
  }
}

/**
 * Compose from a surface that named no account — the Recents widget's compose
 * button, or the menu bar popover with its filter on "All". Neither has an
 * account on screen, so both ask.
 */
async function composeWithoutAccount(): Promise<void> {
  if (!accountsManager) return;
  const picked = await pickAccount(
    accountsManager,
    mainWindow,
    uiString('dialog.composeAccount.detail'),
  );
  if (!picked) return;
  await accountsManager.triggerMailAction('compose');
}

/** Holds or releases the ⌥⌘C global shortcut to match the current setting. */
function syncQuickComposeShortcut(): void {
  setQuickComposeShortcut(loadSettings().quickComposeHotkey, () => {
    // The hotkey works with no window behind it and outlives one, so the manager it composes
    // through is built when it is missing. Hidden: the compose window is what the user asked to
    // see, and the mail window should not appear behind it.
    if (!accountsManager) openWindowForAction(windowActionTarget, undefined, { show: false });
    void openQuickCompose({
      accountsManager,
      preloadPath: getPreloadPath(),
      themeManager,
    });
  });
}

/**
 * The triage a `magimail://thread/` link names, or undefined for any other link.
 *
 * Read before anything is built, because whether the link is triage decides whether a window is
 * needed at all: triage takes the direct write first, and every other link asks to be looked at. A
 * link that names no account cannot be resolved without the manager the window owns, so it is left
 * to the window path rather than guessed at.
 */
function threadTriageFromLink(
  url: string,
): { accountId: string; threadId: string; action: TriageAction } | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'magimail:' || parsed.hostname !== 'thread') return undefined;

    const action = asThreadAction(parsed.searchParams.get('action') ?? 'open');
    if (!action || action === 'open') return undefined;

    const threadId = parsed.pathname.replace(/^\//, '');
    const accountId = parsed.searchParams.get('account') || accountsManager?.getActiveAccountId();
    if (!threadId || !accountId) return undefined;

    return { accountId, threadId, action };
  } catch {
    return undefined;
  }
}

/** Dispatches incoming mailto: or magimail:// protocol URLs to the appropriate handler. */
function dispatchProtocolUrl(url: string): void {
  // Composing needs the manager the window owns, so a window is built for a mailto: link.
  if (url.startsWith('mailto:')) {
    if (!accountsManager)
      openWindowForAction(windowActionTarget, accountIdFromLink(url), { show: false });
    if (!accountsManager) return;
    handleMailtoUrl({ url, accountsManager, mainWindow });
    return;
  }

  if (!url.startsWith('magimail://')) return;

  // Extension actions (widgets, share sheet) trigger deep links — sync extension logs
  // so any newly recorded diagnostics are folded into ~/Library/Logs/Magimail/. Every
  // `magimail://` route is an extension action, a triage link included.
  syncExtensionLogs(logDirectory());

  // A triage link asks for something to happen, not to be looked at, so it takes the route a
  // banner button takes: the direct write first, and a background window only when that cannot
  // land. Nothing about it needs the manager, so none is built for it.
  const triage = threadTriageFromLink(url);
  if (triage) {
    void routeThreadAction(triage.accountId, triage.threadId, triage.action);
    return;
  }

  // Every other link asks to look at something, and resolving an account, composing through one or
  // opening a thread all need the manager the window owns, so a window is built for it.
  if (!accountsManager)
    openWindowForAction(windowActionTarget, accountIdFromLink(url), { show: false });
  if (!accountsManager) return;

  if (url.startsWith('magimail://share')) {
    handleShareUrl({ url, accountsManager, mainWindow });
    return;
  }

  // Everything left asks to see something, so the window is raised before the link is followed.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  try {
    const parsed = new URL(url);
    const targetAccountId = parsed.searchParams.get('account') || undefined;

    if (parsed.hostname === 'inbox') {
      if (targetAccountId) {
        accountsManager.switchAccount(targetAccountId);
      }
    } else if (parsed.hostname === 'search') {
      const query = parsed.searchParams.get('q') || parsed.searchParams.get('query') || '';
      if (query.trim()) {
        accountsManager.openInAccount(
          targetAccountId,
          `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query.trim())}`,
        );
      } else {
        if (targetAccountId) {
          accountsManager.switchAccount(targetAccountId);
        }
        accountsManager.focusSearchInActiveView();
      }
    } else if (parsed.hostname === 'compose') {
      if (targetAccountId) {
        accountsManager.switchAccount(targetAccountId);
        void accountsManager.triggerMailAction('compose', targetAccountId);
      } else {
        void composeWithoutAccount();
      }
    } else if (parsed.hostname === 'thread') {
      const threadId = parsed.pathname.replace(/^\//, '');
      // `?action=` names what to do with the thread, defaulting to opening it. Triage was
      // already answered above, so what arrives here is a link that asks to be looked at:
      // anything else is an action this build does not offer, and is logged as such.
      const action = asThreadAction(parsed.searchParams.get('action') ?? 'open');
      if (threadId && action) {
        // Not getActiveWebContentsView(): account views are loaded lazily, so
        // the target account's view may not exist yet. This is the same path a
        // notification click takes — it switches account, materialises the view
        // and skips the navigation if the thread is already open.
        void accountsManager.performThreadAction(
          targetAccountId || accountsManager.getActiveAccountId(),
          threadId,
          action,
        );
      } else if (threadId) {
        log.warn(
          `Ignoring magimail://thread link with unknown action: ${parsed.searchParams.get('action')}`,
        );
      }
    }
  } catch (err) {
    log.error('Failed to parse protocol URL:', redactUrl(url), err);
  }
}

// macOS open-url event listener for mailto: and magimail:// links
app.on('open-url', (event, url) => {
  event.preventDefault();
  log.info('open-url received:', redactUrl(url));
  if (app.isReady() && initialised) {
    dispatchProtocolUrl(url);
  } else {
    pendingMailtoUrl = url;
  }
});

function getPreloadPath(): string {
  const preload = path.resolve(__dirname, 'preload.js');
  if (!fs.existsSync(preload)) {
    log.error(`No preload script found at ${preload}`);
  }
  return preload;
}

/**
 * Runs a triage action across the window boundary.
 *
 * Routes directly to the account's MailboxSource triageThread method.
 */
async function routeThreadAction(
  accountId: string,
  threadId: string,
  action: TriageAction,
): Promise<ThreadActionOutcome> {
  const source = accountsManager?.getMailboxSource(accountId);
  if (source) {
    const ok = await source.triageThread(threadId, action);
    return ok ? 'ok' : 'failed';
  }
  return 'failed';
}

function createMainWindow(
  initialAccountId?: string,
  { show = true, bounds }: { show?: boolean; bounds?: Rectangle } = {},
): BaseWindow {
  log.info('Creating main window');
  const preloadPath = getPreloadPath();

  const settings = loadSettings();
  const options = createMainWindowOptions({
    title: uiString('window.main.title'),
    minWidth: 960,
    minHeight: 600,
    // A window rebuilt in place returns to where the user had it, so recovering
    // from a blank window does not also move and resize it.
    ...(bounds ?? { width: 1280, height: 850 }),
    ...(settings.transparentBackground
      ? {}
      : {
          vibrancy: undefined as unknown as 'sidebar',
          visualEffectState: undefined as unknown as 'active',
          backgroundColor: getGoogleSurfaceColor(Boolean(themeManager?.isDark())),
        }),
  });

  const win = new BaseWindow(options);
  win.on('closed', () => {
    log.info('Main window closed');
  });

  // Initialize multi-account manager with WebContentsViews and ThemeManager
  accountsManager = new AccountsManager(win, preloadPath, themeManager || undefined);

  // Coming back to the window is when a blank one is most likely to be seen, so the
  // pair is logged: it dates the failure against the suspension that preceded it.
  win.on('show', () => log.info('Main window shown'));
  win.on('hide', () => log.info('Main window hidden'));
  // The helper forwards the filter as soon as it reads it, which can be before the first window,
  // and so before the manager the filter is applied to. Without this a filter that arrived with
  // the window closed would be lost when the next window is built.
  accountsManager.setFocusFilter(getActiveFocusFilter());
  // Named before `initialize()` builds the first view, so a cold launch from a widget
  // or notification opens on the account the link named.
  accountsManager.setInitialAccountId(initialAccountId);
  findInPageController = new FindInPageController(
    win,
    () => accountsManager?.getActiveWebContentsView()?.webContents,
    uiString,
  );
  accountsManager.onAccountSwitched = () => {
    findInPageController?.updateTarget();
  };
  accountsManager.onAccountsChanged = () => {
    updateApplicationMenu(preloadPath);
    // The Settings window keeps its own copy of the account list, taken when it
    // opened, so it has to be told when one is added, removed, reordered or
    // renamed — otherwise its Accounts pane goes stale while the toolbar
    // switcher updates.
    sendToHelper('accounts.update', { accounts: accountsManager?.getAccounts() ?? [] });
    const focused = accountsManager?.getFocusedAccounts() ?? [];
    const total = calculateAggregateUnread(focused);
    updateTrayData(focused, total);
    updateDockBadge(total);
  };
  accountsManager.onThreadStateChanged = (isThread) => updateApplicationMenu(preloadPath, isThread);
  accountsManager.onHistoryChanged = () => updateApplicationMenu(preloadPath);
  accountsManager.onGmailSignIn = (accountId) => {
    void accountsManager?.getMailboxSource(accountId)?.refresh();
  };
  accountsManager.onPollResult = (result) => {
    handlePollResult(result);
  };
  accountsManager.onUnreadChanged = (accounts, total) => {
    updateTrayData(accounts, total, { isRestricted: restrictedAccounts.size > 0 });
    refreshWidgetCache(accounts, total);
  };
  const syncActiveAccountFocus = () => {
    const isWindowActive = Boolean(
      mainWindow && mainWindow.isFocused() && !mainWindow.isMinimized() && mainWindow.isVisible(),
    );
    accountsManager?.setWindowFocused(isWindowActive);
    const activeId = accountsManager?.getActiveAccountId();

    for (const [id, source] of accountsManager?.getMailboxSources().entries() ?? []) {
      const isThisAccountFocused = isWindowActive && id === activeId;
      const absent = accountsManager?.getAbsentCategoriesForAccount(id) || [];
      source.setFocusAndMissingCategories(isThisAccountFocused, absent);
    }
  };

  accountsManager.onAccountSwitched = () => {
    syncActiveAccountFocus();
  };
  accountsManager.onMissingCategoriesChanged = () => {
    syncActiveAccountFocus();
  };
  accountsManager.onAbsentCategoriesChanged = (accountId, absent) => {
    const source = accountsManager?.getMailboxSource(accountId);
    if (source) {
      const isWindowActive = Boolean(
        mainWindow && mainWindow.isFocused() && !mainWindow.isMinimized() && mainWindow.isVisible(),
      );
      const isThisAccountFocused =
        isWindowActive && accountId === accountsManager?.getActiveAccountId();
      source.setFocusAndMissingCategories(isThisAccountFocused, absent);
      if (absent.length > 0 && isThisAccountFocused) {
        void source.handleMailboxChangeHint();
      }
    }
  };

  if (mainWindow) {
    mainWindow.on('focus', () => syncActiveAccountFocus());
    mainWindow.on('blur', () => syncActiveAccountFocus());
    mainWindow.on('minimize', () => syncActiveAccountFocus());
    mainWindow.on('restore', () => syncActiveAccountFocus());
    mainWindow.on('hide', () => syncActiveAccountFocus());
    mainWindow.on('show', () => syncActiveAccountFocus());
  }

  accountsManager.initialize();
  if (process.env.DEBUG || process.env.NODE_ENV !== 'production') {
    (globalThis as unknown as { __accountsManager: unknown }).__accountsManager = accountsManager;
    (globalThis as unknown as { __mailboxSources: unknown }).__mailboxSources =
      accountsManager?.getMailboxSources();
  }

  // Handle actions from the native SwiftUI toolbar
  onNativeToolbarAction((action, value) => {
    switch (action) {
      case 'switchAccount':
        accountsManager?.switchAccount(value);
        break;
      case 'newMessage':
        void composeFromMainWindow({ popout: true });
        break;
      case 'archive':
        accountsManager?.triggerMailAction('archive');
        break;
      case 'trash':
        accountsManager?.triggerMailAction('trash');
        break;
      case 'toggleRead':
        accountsManager?.toggleReadState();
        break;
      case 'reply':
        accountsManager?.triggerMailAction('reply');
        break;
      case 'replyAll':
        accountsManager?.triggerMailAction('replyAll');
        break;
      case 'forward':
        accountsManager?.triggerMailAction('forward');
        break;
      case 'goBack':
        log.info('Back from the trackpad or a mouse side button');
        accountsManager?.goBack();
        break;
      case 'goForward':
        log.info('Forward from the trackpad or a mouse side button');
        accountsManager?.goForward();
        break;
      case 'print':
        accountsManager?.printActiveView();
        break;
      case 'exportPdf':
        accountsManager?.exportActiveThreadToPdf();
        break;
      case 'copyLink':
        accountsManager?.copyActiveThreadLink();
        break;
      case 'shareLink':
        accountsManager?.shareActiveThreadLink();
        break;
      case 'sharePdf':
        accountsManager?.shareActiveThreadAsPdf();
        break;
      case 'search': {
        const activeView = accountsManager?.getActiveWebContentsView();
        if (viewIsAlive(activeView)) {
          activeView.webContents.loadURL(
            `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(value)}`,
          );
        }
        break;
      }
    }
  });

  // BaseWindow has no ready-to-show (no internal page to paint). Show immediately after
  // layout — the WebContentsViews render into the window. A window built for an action
  // rather than for the user stays in the background, and is told so explicitly because a
  // window created hidden never fires `hide`; the default-client prompt goes with the
  // showing, since it is a modal nobody asked to see.
  if (show) {
    win.show();
    defaultClientManager?.checkOnStartup(win);
  } else {
    accountsManager?.handleWindowHidden();
  }
  accountsManager?.updateLayout();

  // When tray is active, hide the window instead of closing — app stays in menu bar
  win.on('close', (event) => {
    // A rebuild closes the window on purpose, so it must not be turned into a hide: a
    // hidden window still holds the blank page the rebuild exists to replace. Any
    // handler added here has to let `rebuildingWindow` through for the same reason.
    if (isTrayCreated() && !isQuitting && !rebuildingWindow) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    // Before the manager goes, so a relaunch restores the account that was last on
    // screen.
    accountsManager?.persistActiveAccount();
    // The account views outlive the window: nothing else closes them, so without
    // this they hold a renderer each until quit, and their suspend timers fire a few
    // minutes later against a destroyed window.
    accountsManager?.suspendAllAccounts();
    // Release the native toolbar with the window it was attached to, so a
    // window recreated from the dock gets a fresh one.
    detachNativeToolbar();
    findInPageController?.destroy();
    findInPageController = null;
    mainWindow = null;
    accountsManager = null;
  });

  return win;
}

/**
 * Serves a reload request: Cmd+R, or Reload in the View menu.
 *
 * It rebuilds the window rather than the account view, for the same reason Magical
 * does. A view rebuild is the cheaper repair, and the right one when only the view's
 * compositor has died, but on 29 October twenty of them ran in twenty seconds in
 * Magical with the window still blank until it was closed and rebuilt. A reload
 * request is a user asking for their mail back, so it does the repair that works.
 */
function reloadMailbox(): void {
  rebuildMainWindow('reload requested');
}

/**
 * Replaces the main window with a fresh one on the same account and bounds.
 *
 * The only recovery observed for a window that has stopped presenting. It costs a
 * Gmail load and a blink of the window.
 */
function rebuildMainWindow(reason: string, detail?: string): void {
  if (!mainWindow || !accountsManager || isQuitting || rebuildingWindow) return;

  const accountId = accountsManager.getActiveAccountId();
  const bounds = mainWindow.getBounds();
  rebuildingWindow = true;
  log.info(`Rebuilding the window: ${reason}${detail ? ` (${detail})` : ''}`);

  // The window's own `closed` handler clears both handles and runs before this
  // listener, so the replacement is built after the old window is gone.
  const previous = mainWindow;
  previous.once('closed', () => {
    rebuildingWindow = false;
    if (isQuitting) return;
    mainWindow = createMainWindow(accountId, { bounds });
  });
  previous.close();
}

// Chromium performance switches — disable unused browser subsystems
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-domain-reliability');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('disable-extensions');
app.commandLine.appendSwitch(
  'disable-features',
  [
    'AutofillServerCommunication',
    'CalculateNativeWinOcclusion',
    'InterestFeedContentSuggestions',
    'MediaSessionService',
    'HardwareMediaKeyHandling',
    'Translate',
    'CertificateTransparencyComponentUpdater',
  ].join(','),
);
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');

// V8 heap cap — prevents old-space from bloating to 500MB+ on 64-bit macOS.
// 256MB is well above Gmail's typical working set (~150MB); it just forces GC to
// collect sooner rather than letting garbage accumulate. Total renderer RSS will
// still be ~400-470MB due to DOM, compositor tiles, and shared libs outside V8.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');

// Ensure standard WebKit/Chromium runtime identity before app ready
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

app.userAgentFallback = DEFAULT_CLEAN_USER_AGENT;

// Ensure single instance
const isE2E = process.env.MAGIMAIL_E2E === '1';
const hasLock = isE2E || app.requestSingleInstanceLock();

if (!hasLock) {
  log.warn('Single instance lock not acquired; quitting');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // On macOS, protocol URLs may arrive as argv in second instance
    const protocolUrl = argv.find((a) => a.startsWith('magimail://') || a.startsWith('mailto:'));
    if (protocolUrl && initialised) {
      log.info('second-instance URL:', redactUrl(protocolUrl));
      dispatchProtocolUrl(protocolUrl);
    }
    if (!mainWindow) mainWindow = createMainWindow();
    else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    log.info('App ready');
    setUiLocale(app.getLocale());
    app.setAboutPanelOptions({
      applicationName: 'Magimail',
      applicationVersion: app.getVersion(),
      copyright: 'Copyright © 2026 Alex Haslam',
      credits:
        'Not affiliated with Google LLC or Apple Inc. Gmail is a trademark of Google LLC. Mac and macOS are trademarks of Apple Inc.',
      website: WEBSITE_URL,
    });
    if (await enforcePrereleaseBuildExpiry()) return;
    logDisplayEnvironment();
    // Before any view exists, so the first injection already uses the override.
    if (initCssOverride(process.argv)) {
      watchCssOverride(() => accountsManager?.reapplyStyles());
    }
    // E2E: Playwright needs a BrowserWindow with a loaded page to connect via CDP
    if (isE2E) {
      const e2eWin = new BrowserWindow({ show: false, width: 1, height: 1 });
      await e2eWin.loadURL('about:blank');
    }

    // Sanitize sessions
    configureGoogleSession('');
    configureGoogleSession(DEFAULT_PARTITION);
    configureGoogleSession('persist:magimail_personal');
    configureGoogleSession('persist:magimail_work');

    const preloadPath = getPreloadPath();

    // 1. Initialize Managers
    themeManager = new ThemeManager();
    defaultClientManager = new DefaultClientManager();

    // Before the helper spawns, so the Settings window is handed the reconciled
    // value rather than a stale one the user already changed in System Settings.
    reconcileLaunchAtLogin();

    // 1b. Spawn Swift helper for native UI
    spawnHelper();
    syncExtensionLogs(logDirectory());

    // A window that has stopped presenting leaves no trace of its own, so the events
    // that could have caused it are recorded beside the show and hide lines: a GPU
    // process that died, and a display that came or went.
    app.on('child-process-gone', (_event, details) => {
      log.warn(
        `Child process gone: ${details.type} ${details.reason} (exit code ${details.exitCode})`,
      );
    });
    screen.on('display-added', () => log.info('Display added'));
    screen.on('display-removed', () => log.info('Display removed'));
    screen.on('display-metrics-changed', () => log.info('Display metrics changed'));

    // Takes back staging that earlier runs, or a crash mid-share, left on disk.
    sweepAbandonedShareStaging();

    // Register with the notification system at launch rather than on the first
    // message: until this runs macOS knows nothing about Magimail, so there is
    // no row in System Settings > Notifications to grant or deny.
    void sendToHelper('notify.setup');

    // A replacement helper comes up blank: no status item, unknown to the
    // notification centre. Registered after the first spawn, so this runs only
    // for replacements.
    onHelperSpawned(() => {
      restoreTray();
      void sendToHelper('notify.setup');
      sendToHelper('accounts.update', { accounts: accountsManager?.getAccounts() ?? [] });
    });
    onHelperEvent((method, params) => {
      if (method === 'app.quit') {
        // A quit addressed to the application reached the helper, which shares
        // this bundle identity. Both processes are one app; shut down together.
        app.quit();
        return;
      }
      if (method === 'settings.changed') {
        const key = params.key as string;
        const value = params.value;
        if (key === 'theme') {
          themeManager?.setTheme(value as 'system' | 'light' | 'dark');
          updateApplicationMenu(preloadPath);
        } else if (key === 'collectDiagnostics') {
          void handleCollectDiagnostics(mainWindow, accountsManager);
        } else {
          saveSetting(key, value);
          // Trigger side effects for specific settings
          if (key === 'pollIntervalSeconds' && typeof value === 'number') {
            const current = loadSettings();
            accountsManager?.setPollIntervals(value, current.pollIntervalBatterySeconds);
          }
          if (key === 'pollIntervalBatterySeconds' && typeof value === 'number') {
            const current = loadSettings();
            accountsManager?.setPollIntervals(current.pollIntervalSeconds, value);
          }
          if (key === 'inactiveAccountSuspendMinutes' && typeof value === 'number') {
            accountsManager?.setSuspendDelayMinutes(value);
          }
          if (key === 'launchAtLogin') {
            applyLaunchAtLogin(Boolean(value));
          }
          if (key === 'quickComposeHotkey') {
            syncQuickComposeShortcut();
          }
          if (key === 'showMenuBarTray') {
            if (value && !isTrayCreated()) {
              createTray();
              const accounts = accountsManager?.getFocusedAccounts() || [];
              const total = calculateAggregateUnread(accounts);
              updateTrayData(accounts, total);
            } else if (!value && isTrayCreated()) {
              destroyTray();
            }
          }
          if (key === 'dockBadgeMode') {
            refreshDockBadge();
          }
          if (
            key === 'menuBarShowDots' ||
            key === 'menuBarShowCount' ||
            key === 'menuBarUnreadOnly'
          ) {
            const accounts = accountsManager?.getFocusedAccounts() || [];
            const total = calculateAggregateUnread(accounts);
            updateTrayData(accounts, total);
          }
          if (key === 'hidePromotionAds' || key === 'hideSidebar') {
            if (value) {
              accountsManager?.reapplyStyles();
            } else {
              accountsManager?.reloadActiveView();
            }
          }
          if (key === 'transparentBackground') {
            const mainWin = accountsManager?.getMainWindow();
            if (mainWin) {
              if (value) {
                mainWin.setVibrancy('sidebar');
                mainWin.setBackgroundColor('#00000000');
              } else {
                mainWin.setVibrancy(null);
                mainWin.setBackgroundColor(getGoogleSurfaceColor(Boolean(themeManager?.isDark())));
              }
            }
          }
          if (key.startsWith('notifications.')) {
            accountsManager?.recalculateMissingCategories();
            const updatedNotifications = loadSettings().notifications;
            accountsManager?.updateNotificationSettings(updatedNotifications);
            accountsManager?.requestImmediatePoll();
          }
        }
      } else if (method === 'account.add') {
        const newAcc = accountsManager?.addAccount(params.name as string, params.color as string);
        if (newAcc) {
          const accounts = accountsManager?.getAccounts() || [];
          const total = accounts.reduce((sum, a) => sum + a.unreadCount, 0);
          updateTrayData(accounts, total);
          refreshWidgetCache(accounts, total);
        }
      } else if (method === 'account.remove') {
        accountsManager?.removeAccount(params.accountId as string);
        const accounts = accountsManager?.getAccounts() || [];
        const total = accounts.reduce((sum, a) => sum + a.unreadCount, 0);
        updateTrayData(accounts, total);
        refreshWidgetCache(accounts, total);
      } else if (method === 'account.reorder') {
        accountsManager?.reorderAccounts(params.accountIds as string[]);
        const accounts = accountsManager?.getAccounts() || [];
        const total = accounts.reduce((sum, a) => sum + a.unreadCount, 0);
        updateTrayData(accounts, total);
        refreshWidgetCache(accounts, total);
      } else if (method === 'account.update') {
        accountsManager?.updateAccountConfig(params.accountId as string, {
          name: params.name as string | undefined,
          color: params.color as string | undefined,
        });
        const accounts = accountsManager?.getAccounts() || [];
        const total = accounts.reduce((sum, a) => sum + a.unreadCount, 0);
        updateTrayData(accounts, total);
        refreshWidgetCache(accounts, total);
      } else if (method === 'account.resetSession') {
        // Settings → Accounts on the account selected in its list, which is not
        // necessarily the one on screen, so the id travels with the event.
        const accountId = params.accountId as string | undefined;
        if (accountId) void accountsManager?.resetSession(accountId);
      } else if (method === 'account.signIn') {
        const accountId = params.accountId as string | undefined;
        if (accountId) {
          // Settings → Accounts on a row whose session has expired. The settings window is the
          // helper's and outlives the main one, so the window holding the account being signed
          // into may be gone; it is built rather than the press dropped, and raised, because
          // signing in asks to look at the page Google serves.
          openWindowForAction(windowActionTarget, accountId);
          if (mainWindow?.isMinimized()) mainWindow.restore();
          accountsManager?.switchAccount(accountId);
        }
      } else if (
        handleTrayEvent(method, params, {
          getMainWindow: () => mainWindow,
          getAccountsManager: () => accountsManager,
          ensureWindow: (accountId, options) =>
            void openWindowForAction(windowActionTarget, accountId, options),
          routeThreadAction: (accountId, threadId, action) =>
            routeThreadAction(accountId, threadId, action),
          composeWithoutAccount: () => composeWithoutAccount(),
          requestImmediatePoll: (accountId) => {
            if (accountId) {
              void accountsManager?.getMailboxSource(accountId)?.handleMailboxChangeHint();
            } else {
              for (const source of accountsManager?.getMailboxSources().values() ?? []) {
                void source.handleMailboxChangeHint();
              }
            }
          },
          pollAllNow: () => {
            void accountsManager?.pressGmailRefreshControl();
            const sources = accountsManager?.getMailboxSources();
            return Promise.allSettled(
              [...(sources?.values() ?? [])].map((source) => source.refresh()),
            ).then(() => {
              for (const accountId of sources?.keys() ?? []) {
                sendTrayMessages(accountId);
              }
            });
          },
          sendMessages: (accountId) => sendTrayMessages(accountId),
          openSettings: () => {
            // The settings pane is fed from the accounts, so a window is built for it when
            // there is none. In the background: opening Preferences does not ask to see the
            // mail window.
            if (!accountsManager)
              openWindowForAction(windowActionTarget, undefined, { show: false });
            openSettingsWindow(undefined, accountsManager?.getAccounts());
          },
          quitApp: () => app.quit(),
        })
      ) {
        // Handled by handleTrayEvent
      } else if (method === 'focusFilter.changed') {
        const activeAccountIds = (params.activeAccountIds as string[]) || [];
        const disableExcludedAccounts = Boolean(params.disableExcludedAccounts);
        const filter =
          activeAccountIds.length > 0 ? { activeAccountIds, disableExcludedAccounts } : null;
        setFocusFilter(filter);
        accountsManager?.setFocusFilter(filter);
      } else {
        // Notification events from Swift helper
        handleNotificationEvent(method, params);
      }
    });

    // 2. Setup IPC listeners
    ipcMain.handle(IPC_CHANNELS.GET_APP_VERSION, () => app.getVersion());

    ipcMain.handle(IPC_CHANNELS.THEME_GET_STATE, () => themeManager?.isDark() || false);

    ipcMain.handle(IPC_CHANNELS.GET_ACCOUNTS, () => ({
      accounts: accountsManager?.getAccounts() || [],
      activeAccountId: accountsManager?.getActiveAccountId() || '',
    }));

    // A renderer noticed its mailbox move (see the title observer in
    // apps/magimail/src/preload.ts). Nudge that account's poller so the badge
    // catches up without waiting for the next scheduled tick. The feed response
    // is still what sets the count — this only changes *when* we ask.
    ipcMain.on(IPC_CHANNELS.MAILBOX_CHANGE_HINT, (event) => {
      const accountId = accountsManager?.getAccountIdForWebContentsId(event.sender.id);
      if (accountId) {
        void accountsManager?.getMailboxSource(accountId)?.handleMailboxChangeHint();
      }
    });

    ipcMain.on(IPC_CHANNELS.DOM_UNREAD_UPDATE, (event, report) => {
      const accountId = accountsManager?.getAccountIdForWebContentsId(event.sender.id);
      if (accountId && report) {
        accountsManager?.handleDomUnreadUpdate(accountId, report);
      }
    });

    ipcMain.on(IPC_CHANNELS.NETWORK_STATUS_CHANGED, (_event, isOnline: boolean) => {
      if (isOnline) {
        accountsManager?.handleNetworkStatusChange(true);
        accountsManager?.requestImmediatePoll();
      }
      const accounts = accountsManager?.getFocusedAccounts() || [];
      const total = calculateAggregateUnread(accounts);
      updateTrayData(accounts, total, {
        isOffline: !isOnline,
        isRestricted: restrictedAccounts.size > 0,
      });
    });

    ipcMain.on(IPC_CHANNELS.SWITCH_ACCOUNT, (_event, accountId: string) => {
      accountsManager?.switchAccount(accountId);
    });

    ipcMain.on(IPC_CHANNELS.ACTION_NEW_MESSAGE, () => {
      void composeFromMainWindow();
    });

    const nudgeActivePoller = () => {
      const activeId = accountsManager?.getActiveAccountId();
      if (activeId) {
        void accountsManager?.getMailboxSource(activeId)?.handleMailboxChangeHint();
      }
    };

    ipcMain.on(IPC_CHANNELS.ACTION_ARCHIVE, () => {
      accountsManager?.triggerMailAction('archive');
      nudgeActivePoller();
    });

    ipcMain.on(IPC_CHANNELS.ACTION_TRASH, () => {
      accountsManager?.triggerMailAction('trash');
      nudgeActivePoller();
    });

    ipcMain.on(IPC_CHANNELS.ACTION_TOGGLE_READ, () => {
      accountsManager?.toggleReadState();
      nudgeActivePoller();
    });

    ipcMain.on(IPC_CHANNELS.ACTION_REPLY, () => {
      accountsManager?.triggerMailAction('reply');
    });

    ipcMain.on(IPC_CHANNELS.ACTION_REPLY_ALL, () => {
      accountsManager?.triggerMailAction('replyAll');
    });

    ipcMain.on(IPC_CHANNELS.ACTION_FORWARD, () => {
      accountsManager?.triggerMailAction('forward');
    });

    ipcMain.on(IPC_CHANNELS.ACTION_SEARCH, () => {
      accountsManager?.focusSearchInActiveView();
    });

    ipcMain.on(IPC_CHANNELS.PERFORM_SEARCH, (_event, query: string) => {
      const activeView = accountsManager?.getActiveWebContentsView();
      if (viewIsAlive(activeView)) {
        activeView.webContents.loadURL(
          `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(query)}`,
        );
      }
    });

    // Settings IPC handlers
    ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, (_event, key?: string) => {
      const settings = loadSettings();
      if (key === 'theme') return themeManager?.getTheme() || 'system';
      return settings;
    });

    ipcMain.handle(IPC_CHANNELS.ACCOUNTS_GET_CONFIG, () => {
      return accountsManager?.getAccounts() || [];
    });

    ipcMain.handle(IPC_CHANNELS.ACCOUNTS_ADD, (_event, name: string, color: string) => {
      const newAcc = accountsManager?.addAccount(name, color);
      if (newAcc) {
        const accounts = accountsManager?.getAccounts() || [];
        const total = accounts.reduce((sum, a) => sum + a.unreadCount, 0);
        updateTrayData(accounts, total);
        refreshWidgetCache(accounts, total);
      }
      return newAcc;
    });

    ipcMain.handle(IPC_CHANNELS.ACCOUNTS_REMOVE, (_event, accountId: string) => {
      const res = accountsManager?.removeAccount(accountId);
      const accounts = accountsManager?.getAccounts() || [];
      const total = accounts.reduce((sum, a) => sum + a.unreadCount, 0);
      updateTrayData(accounts, total);
      refreshWidgetCache(accounts, total);
      return res;
    });

    ipcMain.handle(
      IPC_CHANNELS.ACCOUNTS_UPDATE_CONFIG,
      (_event, accountId: string, updates: { name?: string; color?: string }) => {
        const res = accountsManager?.updateAccountConfig(accountId, updates);
        const accounts = accountsManager?.getAccounts() || [];
        const total = accounts.reduce((sum, a) => sum + a.unreadCount, 0);
        updateTrayData(accounts, total);
        refreshWidgetCache(accounts, total);
        return res;
      },
    );

    ipcMain.handle('magimail:open-external', (_event, url: string) => {
      shell.openExternal(url);
    });

    ipcMain.handle(IPC_CHANNELS.FOCUS_FILTER_GET, () => {
      return accountsManager?.getFocusFilter() || null;
    });

    ipcMain.handle(IPC_CHANNELS.FOCUS_FILTER_SET, (_event, filter: FocusFilterState | null) => {
      setFocusFilter(filter);
      accountsManager?.setFocusFilter(filter);
      sendToHelper('focusFilter.set', {
        activeAccountIds: filter?.activeAccountIds || [],
        disableExcludedAccounts: filter?.disableExcludedAccounts || false,
      });
      return true;
    });

    // Handle poll interval changes
    ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, (_event, key: string, value: unknown) => {
      if (key === 'theme') {
        themeManager?.setTheme(value as 'system' | 'light' | 'dark');
        updateApplicationMenu(preloadPath);
        return true;
      }
      if (key === 'openSettingsPane') {
        openSettingsWindow(value as string, accountsManager?.getAccounts());
        return true;
      }
      saveSetting(key, value);
      if (key === 'pollIntervalSeconds' && typeof value === 'number') {
        const current = loadSettings();
        accountsManager?.setPollIntervals(value, current.pollIntervalBatterySeconds);
      }
      if (key === 'pollIntervalBatterySeconds' && typeof value === 'number') {
        const current = loadSettings();
        accountsManager?.setPollIntervals(current.pollIntervalSeconds, value);
      }
      if (key === 'inactiveAccountSuspendMinutes' && typeof value === 'number') {
        accountsManager?.setSuspendDelayMinutes(value);
      }
      if (key === 'showMenuBarTray') {
        if (value && !isTrayCreated()) {
          createTray();
          const accounts = accountsManager?.getAccounts() || [];
          const total = calculateAggregateUnread(accounts);
          updateTrayData(accounts, total);
        } else if (!value && isTrayCreated()) {
          destroyTray();
        }
      }
      if (key === 'dockBadgeMode') {
        refreshDockBadge();
      }
      if (key === 'menuBarShowDots' || key === 'menuBarShowCount' || key === 'menuBarUnreadOnly') {
        const accounts = accountsManager?.getAccounts() || [];
        const total = calculateAggregateUnread(accounts);
        updateTrayData(accounts, total);
      }
      // Appearance settings: hot-apply when turning on, full reload when untoggling
      if (key === 'hidePromotionAds' || key === 'hideSidebar') {
        if (value) {
          accountsManager?.reapplyStyles();
        } else {
          accountsManager?.reloadActiveView();
        }
      }
      if (key === 'transparentBackground') {
        const mainWin = accountsManager?.getMainWindow();
        if (mainWin) {
          if (value) {
            mainWin.setVibrancy('sidebar');
            mainWin.setBackgroundColor('#00000000');
          } else {
            mainWin.setVibrancy(null);
            mainWin.setBackgroundColor(getGoogleSurfaceColor(Boolean(themeManager?.isDark())));
          }
        }
      }
      if (key.startsWith('notifications.')) {
        accountsManager?.recalculateMissingCategories();
        const updatedNotifications = loadSettings().notifications;
        accountsManager?.updateNotificationSettings(updatedNotifications);
        accountsManager?.requestImmediatePoll();
      }
      return true;
    });

    // 3. Setup Application Menu
    updateApplicationMenu(preloadPath);

    // 4. Create Main Window
    //
    // A cold launch can carry a mailto: or magimail:// link. It is read before the
    // window exists because `AccountsManager.initialize()` is what loads an account's
    // view, so the account the link names has to be known by then.
    const startupUrl =
      pendingMailtoUrl ??
      process.argv.find((a) => a.startsWith('magimail://') || a.startsWith('mailto:')) ??
      null;
    const startupAccountId = startupUrl ? accountIdFromLink(startupUrl) : undefined;
    if (startupUrl) {
      log.info(
        `Cold launch protocol URL detected: ${redactUrl(startupUrl)} ` +
          `targetAccount=${startupAccountId ?? 'none'}`,
      );
    }

    mainWindow = createMainWindow(startupAccountId);

    // 4b. Hold ⌥⌘C if the setting says so. After the window, because the
    // handler composes through the managers it creates.
    syncQuickComposeShortcut();

    // 5. Create menu bar tray if enabled, and populate with initial account data
    {
      const settings = loadSettings();
      const accounts = accountsManager?.getAccounts() || [];
      const totalUnread = calculateAggregateUnread(accounts);
      if (settings.showMenuBarTray) {
        createTray();
        updateTrayData(accounts, totalUnread);
      }
      refreshWidgetCache(accounts, totalUnread);
    }

    // 6. Start Gmail Atom feed pollers and notification routing
    // A banner outlives the window that scheduled it, so each of these serves itself without one:
    // tapping it asks to look at the message and raises the window, and a button is triage and
    // takes the direct write first, the same rule the links and the popover hold to.
    setNotificationClickHandler(({ accountId, messageId }) => {
      openWindowForAction(windowActionTarget, accountId)?.performThreadAction(
        accountId,
        messageId,
        'open',
      );
    });
    setNotificationActionHandler(({ accountId, messageId, action }) => {
      const wanted = asThreadAction(action, TRIAGE_ACTIONS);
      if (!wanted) {
        log.warn(`Ignoring notification action this build does not offer: ${action}`);
        return;
      }
      void routeThreadAction(accountId, messageId, wanted as TriageAction);
    });

    // 7. Dispatch the startup protocol URL captured before the window, now that the
    // account it named is the one already loaded.
    if (startupUrl && accountsManager) {
      log.info('Dispatching startup protocol URL:', redactUrl(startupUrl));
      dispatchProtocolUrl(startupUrl);
      pendingMailtoUrl = null;
    }

    // From here a protocol URL is dispatched rather than queued, so a window it needs is
    // built for it; see the `open-url` listener.
    initialised = true;

    // 8. Sleep / Wake Lifecycle Listener
    powerMonitor.on('resume', () => {
      log.info('System resumed from sleep, reloading active view and refreshing mailbox sources');
      accountsManager?.reloadActiveViewOnResume();
      for (const source of accountsManager?.getMailboxSources().values() ?? []) {
        void source.handleWindowWakeOrUnhide();
      }
    });

    app.on('activate', () => {
      if (BaseWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      } else if (mainWindow) {
        mainWindow.show();
      }
    });

    app.on('before-quit', () => {
      log.info('App shutting down; cleaning up pollers, helper, and sessions');
      isQuitting = true;
      releaseQuickComposeShortcut();
      destroyTray();
      killHelper();
      accountsManager?.stopMailboxSources();
      accountsManager?.persistActiveAccount();
      accountsManager?.suspendAllAccounts();
      try {
        session.fromPartition('persist:magimail_work').flushStorageData();
        session.fromPartition('persist:magimail_personal').flushStorageData();
      } catch {
        // Ignore on teardown
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
