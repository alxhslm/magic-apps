import {
  app,
  BaseWindow,
  dialog,
  Menu,
  nativeTheme,
  powerMonitor,
  shell,
  type Rectangle,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {
  prereleaseBuildExpiredMessage,
  configureSecretFiles,
  createMainWindowOptions,
  FindInPageController,
  getGoogleSurfaceColor,
  isDemoMode,
  isPrereleaseBuildExpired,
  openWindowForAction,
  resolveUserDataPath,
  routeAcrossWindow,
  WEBSITE_URL,
  type WindowActionTarget,
  viewIsAlive,
  WindowRebuilder,
} from '@magimail/core';
import { localCacheKey } from './native-addon.js';
import { AccountsManager, calendarPreloadPath } from './accounts-manager.js';
import { loadSettings, saveSetting, type MagicalSettings } from './settings-store.js';
import { buildAppMenu } from './menu.js';
import { setUiLocale, uiString } from './strings.js';
import {
  openSettingsWindow,
  pushAccountsToSettings,
  pushCalendarsToSettings,
  pushSettingsToHelper,
} from './settings.js';
import { applyLaunchAtLogin, reconcileLaunchAtLogin } from './login-item.js';
import { killHelper, onHelperEvent, onHelperSpawned, spawnHelper } from './swift-helper.js';
import {
  attachNativeToolbar,
  onNativeToolbarAction,
  runToolbarCustomization,
  setNativeToolbarMode,
  updateNativeToolbarAccounts,
} from './native-toolbar.js';
import { chooseEventAccount } from './account-picker.js';
import { SidebarManager } from './sidebar-manager.js';
import { CALENDAR_MIN_HEIGHT, windowMinWidth } from './window-layout.js';
import { CALENDAR_BASE_URL } from './constants.js';
import { initDock } from './dock.js';
import { syncExtensionLogs } from './extension-logs.js';
import { handleCollectDiagnostics } from './diagnostics.js';
import {
  createLogger,
  initLogging,
  installCrashHandlers,
  logDirectory,
  logDisplayEnvironment,
  logStartupBanner,
  redactUrl,
} from '@magimail/core/logger';
import { CalendarService } from './calendar-service.js';
import type { SourceHealth } from './calendar-poller.js';
import {
  dispatchNotice,
  handleNotificationEvent,
  prepareNotifications,
} from './notification-manager.js';
import {
  handleFocusFilterEvent,
  isAccountDisabledByFocus,
  isAccountSilencedByFocus,
} from './focus-filter-manager.js';
import { accountIdFromLink, MAGICAL_PROTOCOL } from './event-links.js';
import { onIcsFile, readIcsFile, watchForIcsFiles } from './ics-handler.js';
import { offerToBecomeDefault, promptSetAsDefault } from './default-client.js';
import { describeIcs, summariseIcs } from './ics-file.js';
import type { IcsImportOutcome } from './ics-import.js';
import { MenuBarManager } from './menubar-manager.js';
import { canRemoveAllAppData, removeAllAppDataAndQuit } from './remove-all-data.js';
import { SyncCalendarActionDriver } from './calendar-actions/sync-driver.js';
import { loadAccounts } from './accounts.js';

// Replaced by tsup at build time with the Unix milliseconds the bundle was
// compiled at; see `prerelease-build-expiry.ts` in @magimail/core.
declare const __BUILD_TIMESTAMP__: number;

// A stable userData path across dev and packaged runs, so a signed-in account
// survives the switch between `pnpm dev` and the installed bundle.
app.name = 'Magical';
if (isDemoMode()) {
  // A demo is its own app identity, not just its own userData. Chromium names the
  // keychain item that wraps cookie encryption after the app, so without this a demo
  // shares `Magical Safe Storage` with the real install. An unpackaged build whose
  // signature that item does not trust can then invalidate the key for every profile at
  // once, demo included. The log directory is pinned back to the real one, so the
  // debugging skills keep reading a single `main.log`.
  const logsPath = app.getPath('logs');
  app.name = 'Magical-demo';
  app.setPath('logs', logsPath);
}
// Registered before `whenReady`, so a `magical://` link that launches the app is
// delivered rather than dropped. The same holds for a double-clicked `.ics`, which
// macOS delivers as `open-file` the moment the app starts.
// Claimed here but reported below, once the logger exists: moving the claim
// later would risk a launching link arriving before it is registered.
const protocolClaimed = app.setAsDefaultProtocolClient(MAGICAL_PROTOCOL);
watchForIcsFiles();
try {
  const userData = resolveUserDataPath({
    appName: 'Magical',
    appDataPath: app.getPath('appData'),
  });
  app.setPath('userData', userData);
  if (isDemoMode()) {
    // Inherited by the helper, which spawns later: `MAGIC_SUITE_DEMO` tells it to read the
    // demo profile's focus-filter.json rather than the App Group, and `MAGICAL_USER_DATA_DIR`
    // is the exact profile even when it came from `--user-data-dir`. Both apps spawn the same
    // helper shape, so the flag is suite-wide.
    process.env.MAGIC_SUITE_DEMO = '1';
    process.env.MAGICAL_USER_DATA_DIR = userData;
  }
} catch {
  // Already set.
}

// Before `whenReady`: Chromium reads the remote debugging port as it starts, so a
// switch appended later is ignored. Account views are the only way to see what
// Calendar's DOM is actually doing, and they are invisible to any other tool.
const debugPortArg = process.argv.find(
  (a) => a.startsWith('--debug-port=') || a === '--debug-port',
);
let debugPort: string | null = null;
if (debugPortArg) {
  debugPort = debugPortArg.includes('=') ? debugPortArg.split('=')[1] : '9223';
  app.commandLine.appendSwitch('remote-debugging-port', debugPort);
}

// Chromium performance switches — disable unused browser subsystems. Magimail has
// had these since it moved to BaseWindow; Magical was scaffolded without them, so its
// renderer is the one Chromium is free to mark occluded and pace like a background tab.
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

// Before anything that can throw. Writes to ~/Library/Logs/Magical/main.log --
// the app name decides the directory, so the two apps never share a file.
initLogging({ isPackaged: app.isPackaged });
logStartupBanner('Magical', app.getVersion());
installCrashHandlers({
  describeRenderer: (id) => accounts?.getAccountIdForWebContentsId(id),
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

// Before the first read of settings, the event cache or the alert record. The key
// comes from the login keychain, which only a signed build can reach, so an
// unpackaged one keeps reading and writing plaintext.
configureSecretFiles({
  isPackaged: app.isPackaged,
  fetchKey: localCacheKey,
  logger: createLogger('SecretFile'),
});

// Without the scheme, every widget tap, notification click and deep link
// stops reaching the app at once, and the report is "nothing happens".
if (!protocolClaimed) {
  log.error(`macOS refused the ${MAGICAL_PROTOCOL}: claim; deep links will not reach the app`);
}

if (debugPort) {
  // Printed rather than left implicit: attaching means finding the page target,
  // and the endpoint is the one thing a debugger client needs to be told.
  log.info(`Remote debugging on http://127.0.0.1:${debugPort} (targets at /json/list)`);
}

/**
 * One Magical at a time.
 *
 * Every account's cookies and IndexedDB live under the shared userData path, and
 * Chromium takes an exclusive lock on each. A second instance does not fail
 * loudly — it comes up with the calendar half-working and a stream of LevelDB
 * LOCK errors, which is easy to mistake for a broken account. Running
 * `pnpm dev` while the installed app is open is the normal way to hit it.
 */
if (!app.requestSingleInstanceLock()) {
  log.warn('Single instance lock not acquired; quitting');
  app.quit();
}

let pendingProtocolUrl: string | null = null;

// macOS open-url event listener for magical:// links.
// Registered before whenReady so links that launch the app are not dropped.
app.on('open-url', (event, url) => {
  event.preventDefault();
  log.info('open-url received:', redactUrl(url));
  // The test is for the service, not the accounts: the launch pass has finished, so a link arriving
  // now builds its own window instead of waiting for a cold launch that already happened.
  if (app.isReady() && calendarService) {
    dispatchProtocolUrl(url);
  } else {
    pendingProtocolUrl = url;
  }
});

app.on('second-instance', (_event, argv) => {
  log.info('Second instance launched; focusing main window');
  const protocolUrl = argv.find((a) => a.startsWith(`${MAGICAL_PROTOCOL}://`));
  if (protocolUrl && calendarService) {
    log.info('second-instance URL:', redactUrl(protocolUrl));
    dispatchProtocolUrl(protocolUrl);
  }
  if (!mainWindow) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

let mainWindow: BaseWindow | null = null;
let findInPageController: FindInPageController | null = null;
let calendarService: CalendarService | null = null;
let accounts: AccountsManager | null = null;
let menuBarManager: MenuBarManager | null = null;
let sidebarManager: SidebarManager | null = null;
/** Set before quitting, so the window being torn down is not rebuilt afterwards. */
let quitting = false;
/**
 * The window rebuild both apps share. It reads the handles below rather than capturing
 * them, so it survives a window being replaced.
 */
const windowRebuilder = new WindowRebuilder<AccountsManager>({
  window: () => mainWindow,
  manager: () => accounts,
  accountId: (manager) => manager.getActiveAccountId(),
  quitting: () => quitting,
  build: (accountId, bounds) => createWindow(accountId, { bounds }),
  log,
});

/** Magical's window handles, for the shared action policy. */
const windowActionTarget: WindowActionTarget<AccountsManager> = {
  getWindow: () => mainWindow,
  createWindow: (accountId, options) => createWindow(accountId, options),
  focusApp: () => app.focus({ steal: true }),
  getManager: () => accounts,
};

function applyMenu(): void {
  if (!accounts) return;
  const manager = accounts;

  // Left off the menu entirely -- rather than disabled -- on a run that is not the
  // installed app: the item removes the install's own files, and a `--profile` or
  // demo run would be deleting another profile's accounts.
  const onRemoveAllData = canRemoveAllAppData() ? () => void removeAllAppDataAndQuit() : undefined;

  Menu.setApplicationMenu(
    buildAppMenu({
      accounts: manager.getAccounts().map((a) => ({
        id: a.id,
        name: a.name,
        disabledByFocus: isAccountDisabledByFocus(a, manager.getActiveAccountId()),
      })),
      activeAccountId: manager.getActiveAccountId(),
      onSwitchAccount: (index) => manager.switchToIndex(index),
      onOpenSettings: () =>
        openSettingsWindow(
          manager,
          'general',
          calendarService?.getCachedEvents(),
          accountsNeedingSignIn(),
        ),
      onReload: () => reloadCalendar(),
      onGoBack: () => manager.goBack(),
      onGoForward: () => manager.goForward(),
      canGoBack: manager.canGoBack(),
      canGoForward: manager.canGoForward(),
      onNewEvent: () => handleNewEvent(),
      onImportFile: () => void handleImportFile(),
      onSetAsDefault: () => void promptSetAsDefault(mainWindow),
      onFindInPage: () => {
        findInPageController?.show();
      },
      onFindNext: () => {
        findInPageController?.findNext();
      },
      onFindPrevious: () => {
        findInPageController?.findPrevious();
      },
      onSearchCalendar: () => {
        handleSearch();
      },
      onSearch: () => handleSearch(),
      onCustomizeToolbar: () => runToolbarCustomization(),
      onToggleSidebar: () => sidebarManager?.toggleSidebar(),
      currentTheme: loadSettings().theme,
      onSetTheme: applyTheme,
      onRemoveAllData,
      onCollectDiagnostics: () => {
        void handleCollectDiagnostics(mainWindow, accounts);
      },
      onRevealLogs: () => {
        const dir = logDirectory();
        // The directory exists only once something has been written to it, and
        // on a first run that may not have happened yet.
        fs.mkdirSync(dir, { recursive: true });
        syncExtensionLogs(dir);
        shell.openPath(dir).then((err) => {
          if (err) log.error('Could not open the log folder:', err);
        });
      },
    }),
  );
}

function applyTheme(theme: MagicalSettings['theme']): void {
  nativeTheme.themeSource = theme;
  saveSetting('theme', theme);
  // The View menu and the General tab write the same value, so whichever was
  // not used has to be told.
  pushSettingsToHelper();
  applyMenu();
}

/**
 * Settings edited in the helper's window arrive one key at a time.
 *
 * Only keys the settings file declares are accepted. The helper is a separate
 * process on the other side of a text protocol, and a typo'd key would
 * otherwise be written into the file and persist forever.
 */
/**
 * Redraws the toolbar's account switcher.
 *
 * Each segment's dot is filled when invitations have arrived on that account and not yet
 * been dealt with. It is the only thing that says *where* something is waiting: the
 * dropdown lists the active account alone, and the Dock badge is one number for the app.
 */
/**
 * How each account's last calendar read went, as the surfaces outside the popover need
 * it.
 *
 * Held here rather than asked of `CalendarService` because the toolbar and the settings
 * window are redrawn on their own occasions — adding an account, switching account,
 * answering an invitation — and none of those is a poll. A map updated as the service
 * reports is readable at any of those moments; a getter would only be current at one.
 */
const accountHealth = new Map<string, SourceHealth>();

/** Accounts whose session has expired, which is the one failure the user can fix. */
function accountsNeedingSignIn(): Set<string> {
  const ids = new Set<string>();
  for (const [id, health] of accountHealth) if (health === 'signed-out') ids.add(id);
  return ids;
}

/**
 * Drops everything keyed by an account that has gone.
 *
 * The health map outlives the account it describes, and a calendar mute or a hidden
 * calendar names its account: an entry left behind is dead weight that would reappear if
 * the same account id were ever reused. They are the user's own choices, not caches, so
 * only entries naming a gone account are dropped.
 */
function forgetAccountSettings(live: ReadonlySet<string>): void {
  for (const id of [...accountHealth.keys()]) if (!live.has(id)) accountHealth.delete(id);

  const hidden = loadSettings().hiddenCalendars ?? [];
  const keptHidden = hidden.filter((ref) => live.has(ref.accountId));
  if (keptHidden.length !== hidden.length) saveSetting('hiddenCalendars', keptHidden);

  // A mute names `accountId|calendarId`; a bare calendar id is the older, account-wide
  // shape and is left alone because no account can be read out of it.
  const muted = loadSettings().disabledAlertCalendarIds ?? [];
  const keptMuted = muted.filter((entry) => {
    const sep = entry.indexOf('|');
    return sep < 0 ? true : live.has(entry.slice(0, sep));
  });
  if (keptMuted.length !== muted.length) saveSetting('disabledAlertCalendarIds', keptMuted);
}

function pushToolbarAccounts(): void {
  const manager = accounts;
  if (!manager) return;

  const arrivals = calendarService?.newArrivalsByAccount() ?? new Map<string, number>();
  const activeAccountId = manager.getActiveAccountId();
  const needsSignIn = accountsNeedingSignIn();
  updateNativeToolbarAccounts(
    manager.getAccounts().map((account) => ({
      ...account,
      unreadCount: arrivals.get(account.id) ?? 0,
      // An account a Focus has silenced entirely keeps its segment and loses the weight of
      // its dot; one the filter also blocks is greyed by AppKit and cannot be clicked. See
      // docs/magical/focus-filters.md#what-a-filter-silences.
      excludedByFocus: isAccountSilencedByFocus(account),
      disabledByFocus: isAccountDisabledByFocus(account, activeAccountId),
      // Drawn as a warning glyph in place of the dot, by `AccountSegmentedControl`. It
      // is the only thing in the main window that says an account has stopped reading,
      // and it says which one, which the sidebar cannot.
      needsAuth: needsSignIn.has(account.id),
    })),
    activeAccountId,
  );
}

function applySettingChange(key: string, value: unknown): void {
  const known = Object.keys(loadSettings()) as (keyof MagicalSettings)[];
  if (!known.includes(key as keyof MagicalSettings)) {
    log.warn(`Ignoring unknown setting ${key}`);
    return;
  }

  log.info(`Setting ${key} = ${String(value)}`);
  saveSetting(key as keyof MagicalSettings, value as never);

  switch (key) {
    case 'theme':
      nativeTheme.themeSource = value as MagicalSettings['theme'];
      applyMenu();
      return;

    case 'launchAtLogin':
      applyLaunchAtLogin(Boolean(value));
      return;

    case 'transparentBackground':
      // The CSS is only half of it: the window's own vibrancy has to go too, or
      // switching transparency off leaves the material behind a page that now
      // covers it. Same pair Magimail sets.
      applyWindowTransparency(Boolean(value));
      accounts?.reinjectCss();
      sidebarManager?.setTransparency(Boolean(value), nativeTheme.shouldUseDarkColors);
      return;

    case 'hideSidebar':
      // Turning it on is a CSS re-inject. Turning it off is a reload, as in
      // Magimail: Google has laid the page out without the panel by then, and
      // removing the rule does not make it lay out again.
      if (value) accounts?.reinjectCss();
      else accounts?.reloadActive();
      return;

    case 'hideTasksTab':
      // Turning it on is a CSS re-inject. Turning it off is a reload, like the
      // sidebar: Google has laid the page out without the switcher by then, and
      // removing the rule does not make it lay out again. Hiding while the Tasks
      // page is on screen also routes back to the calendar, since the switcher
      // that would do it is now gone; see `leaveTasksRouteIfActive`.
      if (value) {
        accounts?.reinjectCss();
        accounts?.leaveTasksRouteIfActive();
      } else {
        accounts?.reloadActive();
      }
      return;

    case 'inactiveAccountSuspendMinutes':
      accounts?.setSuspendDelayMinutes(Number(value));
      return;

    case 'dockBadgeMode':
      calendarService?.applyBadgeSetting();
      return;

    case 'meetingAlertsEnabled':
    case 'meetingAlertLeadMinutes':
    case 'disabledAlertCalendarIds':
      // Re-arms the timers against the new lead or calendar filter, and polls straight
      // away so turning alerts back on does not wait for the next scheduled tick.
      calendarService?.applySettings();
      return;

    case 'showMenuBarIcon':
      if (value) {
        if (!menuBarManager) {
          menuBarManager = new MenuBarManager(
            () => mainWindow,
            () => accounts,
            () => calendarService,
            (targetAccountId) => void handleNewEvent(targetAccountId, true),
            openSettingsFromMenuBar,
            openAppFromMenuBar,
            (query, accountId) => handleSearch(query, accountId),
          );
        }
        menuBarManager.onHiddenCalendarsChanged = () => sidebarManager?.pushData();
        menuBarManager.createTray();
        if (accounts) menuBarManager.updateAccounts(accounts.getAccounts());
        if (calendarService) menuBarManager.updateEvents(calendarService.getCachedEvents());
      } else {
        menuBarManager?.destroyTray();
      }
      return;

    case 'menuBarDisplayMode':
    case 'showMenuBarAccountColor':
    case 'isCalendarCollapsed':
    case 'showCompletedTasks':
      menuBarManager?.pushUpdate();
      return;
  }
}

/** Opaque means no vibrancy at all, not vibrancy hidden behind an opaque page. */
function applyWindowTransparency(transparent: boolean): void {
  if (!mainWindow) return;

  if (transparent) {
    mainWindow.setVibrancy('sidebar');
    mainWindow.setBackgroundColor('#00000000');
  } else {
    mainWindow.setVibrancy(null);
    mainWindow.setBackgroundColor(getGoogleSurfaceColor(nativeTheme.shouldUseDarkColors));
  }
}

/**
 * The direct `sync.sync` writes, built here rather than in `AccountsManager` so they outlive the
 * window. Each account comes from the manager while there is one, and from disk when there is not.
 */
const directActions = new SyncCalendarActionDriver({
  getAccountContext: (accountId) => {
    const account = (accounts?.getAccounts() ?? loadAccounts()).find((a) => a.id === accountId);
    if (!account) return undefined;
    return {
      id: account.id,
      partition: account.partition,
      gaiaId: account.gaiaId,
      apiKey: account.apiKey,
      email: account.email,
    };
  },
});

/**
 * Makes sure a window exists for a link, without bringing it forward.
 *
 * Reveal and navigate raise it themselves. An answering or deleting link does not, because it runs
 * through the drivers a banner uses.
 */
function ensureWindowForLink(accountId: string): void {
  openWindowForAction(windowActionTarget, accountId, { show: false });
}

/** Opens settings, building the window its account list comes from. */
function openSettingsFromMenuBar(): void {
  if (!accounts) createWindow();
  if (!accounts) return;
  openSettingsWindow(
    accounts,
    'general',
    calendarService?.getCachedEvents(),
    accountsNeedingSignIn(),
  );
}

/** Brings the window up, on the account the menu bar named. */
function openAppFromMenuBar(accountId?: string): void {
  void openWindowForAction(windowActionTarget, accountId);
}

/**
 * Meeting alerts, and the polling that feeds them.
 *
 * Constructed once the window exists: the reveal and navigate callbacks it is given drive
 * an account's view, and there is none before `createWindow`. The direct RSVP write is
 * deliberately built outside it, so answering a banner survives the window closing.
 */
function startCalendarService(): void {
  if (!accounts) return;

  calendarService = new CalendarService(
    () => accounts?.getAccounts() ?? [],
    (accountId, url) => {
      accounts?.openInAccount(accountId, url);
      app.focus({ steal: true });
      mainWindow?.show();
      mainWindow?.focus();
    },
    // Triage: none of these raises the window, and `routeAcrossWindow` holds the rule for all three.
    (accountId, eid, response, startTime, timing) =>
      routeAcrossWindow({
        window: () =>
          accounts ? accounts.performRsvp(accountId, eid, response, startTime, timing) : null,
        direct: () =>
          directActions.performRsvp(undefined, accountId, eid, response, startTime, timing),
        openWindow: () =>
          openWindowForAction(windowActionTarget, accountId, { show: false })?.performRsvp(
            accountId,
            eid,
            response,
            startTime,
            timing,
          ) ?? Promise.resolve('failed'),
      }),
    // Following a link is a request to look at something, so this one raises the window,
    // unlike an RSVP. It does so *before* revealing rather than after: a background view
    // is not laid out at the size its own rects describe, so a click computed against it
    // lands outside the viewport.
    async (accountId, eid, at) => {
      accounts?.switchAccount(accountId);
      app.focus({ steal: true });
      mainWindow?.show();
      mainWindow?.focus();

      return (await accounts?.revealEvent(accountId, eid, at)) ?? 'failed';
    },
    // How each account's last read went, which is where the popover's offline, sign-in
    // and last-synced banners come from. Without it a signed-out account draws an agenda
    // that has simply stopped moving.
    (accountId, health, lastSuccessfulReadAt) => {
      const previous = accountHealth.get(accountId);
      accountHealth.set(accountId, health);
      menuBarManager?.setAccountHealth(accountId, health, lastSuccessfulReadAt);
      // A poll that succeeds after an outage is proof the network is back. The offline
      // page retries itself on the renderer's own `online` event, which is faster; this
      // is the backstop for when that event does not arrive, and it reloads the page the
      // user was actually on rather than leaving a dead view behind.
      if (previous === 'offline' && health === 'ok') {
        accounts?.handleNetworkStatusChange(true);
      }
      // The toolbar and the settings window only carry the signed-out state, so redraw
      // them when that is what changed rather than on every poll.
      if ((previous === 'signed-out') !== (health === 'signed-out')) {
        pushToolbarAccounts();
        if (accounts)
          pushAccountsToSettings(
            accounts,
            calendarService?.getCachedEvents(),
            accountsNeedingSignIn(),
          );
      }
    },
    // Deleting and completing take the same route as an RSVP.
    (accountId, eid, startTime, isTask) =>
      routeAcrossWindow({
        window: () => (accounts ? accounts.deleteEvent(accountId, eid, startTime, isTask) : null),
        direct: () => directActions.deleteEvent(undefined, accountId, eid, startTime, isTask),
        openWindow: () =>
          openWindowForAction(windowActionTarget, accountId, { show: false })?.deleteEvent(
            accountId,
            eid,
            startTime,
            isTask,
          ) ?? Promise.resolve('failed'),
      }),
    (accountId, eid, startTime, completed) =>
      routeAcrossWindow({
        window: () =>
          accounts ? accounts.setTaskCompleted(accountId, eid, startTime, completed) : null,
        direct: () =>
          directActions.setTaskCompleted(undefined, accountId, eid, startTime, completed),
        openWindow: () =>
          openWindowForAction(windowActionTarget, accountId, { show: false })?.setTaskCompleted(
            accountId,
            eid,
            startTime,
            completed,
          ) ?? Promise.resolve('failed'),
      }),
    // A link asks to look at something, so a closed window is opened for it rather than the
    // link dropped. The account is named so the view that loads is the one the link is
    // about, and the lookup a link does next resolves against the manager this builds.
    (accountId) => ensureWindowForLink(accountId),
  );

  // Calendars are learned from each account's own view, so a first-run account starts
  // with none; rebuild the pollers the moment they are discovered.
  accounts.onCalendarIdsChanged = () => {
    calendarService?.syncPollers();
    if (accounts) {
      pushCalendarsToSettings(accounts, calendarService?.getCachedEvents());
      menuBarManager?.updateAccounts(accounts.getAccounts());
      sidebarManager?.updateAccounts(accounts.getAccounts());
    }
  };

  calendarService.onEventsUpdated = (events) => {
    menuBarManager?.updateEvents(events);
    sidebarManager?.updateEvents(events);
    if (accounts) {
      pushCalendarsToSettings(accounts, events);
    }
  };
  if (calendarService.getCachedEvents().size > 0) {
    menuBarManager?.updateEvents(calendarService.getCachedEvents());
    sidebarManager?.updateEvents(calendarService.getCachedEvents());
  }

  calendarService.setActiveAccount(accounts.getActiveAccountId());
  calendarService.onInvitesChanged = () => {
    pushToolbarAccounts();
    // The tray carries each account's outstanding count too, and answering from a banner
    // has to move it straight away rather than at the next poll.
    menuBarManager?.pushUpdate();
  };
  calendarService.start();
}

function handleHelperEvent(method: string, params: Record<string, unknown>): void {
  // Notifications are answered whether or not the accounts manager exists yet; a banner
  // can outlive the window that scheduled it.
  if (handleNotificationEvent(method, params)) return;

  // Before the accounts manager too: the helper forwards the filter as soon as it reads
  // it, which is at its own launch and so ahead of the first window.
  if (handleFocusFilterEvent(method, params)) {
    calendarService?.applyFocusFilter();
    // The switcher's dots and the Accounts menu carry the filter as emphasis, so both are
    // redrawn here rather than waiting for the next poll or account change.
    pushToolbarAccounts();
    applyMenu();
    menuBarManager?.applyFocusFilter();
    return;
  }

  // Menu bar tray events (opening app, settings, quick-add, calls, rsvps, etc.)
  if (menuBarManager?.handleEvent(method, params)) return;

  // Settings come from the helper's own window, which outlives the main one; the helper holds only
  // what a `settings.show` last carried, so a change made with no window has to be saved here.
  // Everything below needs the manager the main window owns.
  if (method === 'settings.changed') {
    if (params.key === 'collectDiagnostics') {
      void handleCollectDiagnostics(mainWindow, accounts);
      return;
    }
    applySettingChange(String(params.key), params.value);
    return;
  }

  const manager = accounts;
  if (!manager) return;

  switch (method) {
    case 'account.resetSession': {
      // Settings → Accounts on the account selected in its list, which is not
      // necessarily the one on screen, so the id travels with the event.
      void manager.resetSession(String(params.accountId));
      break;
    }

    case 'account.add':
      manager.addAccount(params.name as string, params.color as string);
      break;

    case 'account.remove':
      // No confirmation here: the settings window's own list is where removing
      // a row is the obvious, reversible-looking gesture, and it is the
      // surface the user went to in order to manage accounts.
      manager.removeAccount(String(params.accountId));
      break;

    case 'account.update':
      manager.updateAccount(String(params.accountId), {
        name: params.name as string | undefined,
        color: params.color as string | undefined,
      });
      break;

    // Settings → Accounts, on a row whose session has expired. Switching to the account
    // builds its view and lands on Google's sign-in page, which is the only place the
    // user can actually fix it.
    case 'account.signIn': {
      const accountId = params.accountId as string | undefined;
      if (!accountId) break;
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
      app.focus({ steal: true });
      manager.switchAccount(accountId);
      pushToolbarAccounts();
      break;
    }

    case 'account.reorder':
      if (
        Array.isArray(params.accountIds) &&
        params.accountIds.every((id) => typeof id === 'string')
      ) {
        manager.reorderAccounts(params.accountIds as string[]);
      }
      break;

    case 'app.quit':
      app.quit();
      break;
  }
}

/**
 * Routes a `magical://` link to the appropriate handler (search, widgets, or events/dates).
 */
function dispatchProtocolUrl(rawUrl: string): void {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== `${MAGICAL_PROTOCOL}:`) return;

    if (parsed.hostname === 'search') {
      const query = parsed.searchParams.get('q') || parsed.searchParams.get('query') || '';
      const targetAccountId = parsed.searchParams.get('account') || undefined;
      handleSearch(query, targetAccountId);
      return;
    }
  } catch {
    // If URL parsing fails, let handleWidgetLink / calendarService attempt or log warning
  }

  if (handleWidgetLink(rawUrl)) return;
  calendarService?.openDeepLink(rawUrl);
}

/**
 * The two links a widget can produce that name no event.
 *
 * `openDeepLink` answers `magical://event` and `magical://date`, both of which
 * require an account and an event or a day. A widget's header buttons have
 * neither: they mean "write something down" and "show me the app". Handled here
 * rather than in `parseEventLink`, which refuses a link it does not recognise on
 * purpose, and would have to gain an account-less shape to take these.
 */
function handleWidgetLink(rawUrl: string): boolean {
  if (rawUrl === 'magical://quick-add') {
    log.info('Widget asked for a new event');
    void handleNewEvent(undefined, true);
    return true;
  }
  if (rawUrl === 'magical://open') {
    log.info('Widget asked to open the app');
    if (!mainWindow) createWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
    return true;
  }
  return false;
}

async function handleNewEvent(targetAccountId?: string, external = false): Promise<void> {
  // The menu bar and the widget have no window behind them, and the accounts come from one.
  if (!accounts) createWindow();
  const manager = accounts;
  if (!manager) return;

  const account = targetAccountId
    ? manager.getAccounts().find((a) => a.id === targetAccountId)
    : await chooseEventAccount(manager, {
        parentWindow: mainWindow,
        fromMainWindow: !external,
      });
  if (!account) return;

  if (account.id !== manager.getActiveAccountId()) {
    manager.switchAccount(account.id);
    pushToolbarAccounts();
    applyMenu();
  }

  await manager.triggerCalendarAction('createEvent', account.id);
}

/**
 * The toolbar's New Task, and the Tasks page's own capture.
 *
 * Always the account on screen. The account picker is for an entry point that arrives
 * from outside the window — a deep link or a widget — where there is no active account
 * to stand in for an answer. The toolbar is inside the window, so it captures for the
 * account the user is already looking at; `addEventAccountPicker` names events, and
 * asking for a task there would put a dialog in the middle of an instant capture.
 */
async function handleNewTask(targetAccountId?: string): Promise<void> {
  // Same reason as `handleNewEvent`: the manager comes from the window.
  if (!accounts) createWindow();
  const manager = accounts;
  if (!manager) return;

  const account = targetAccountId
    ? manager.getAccounts().find((a) => a.id === targetAccountId)
    : manager.getActiveAccount();
  if (!account) return;

  if (account.id !== manager.getActiveAccountId()) {
    manager.switchAccount(account.id);
    pushToolbarAccounts();
    applyMenu();
  }

  await manager.triggerNewTask(account.id);
}

/**
 * File → Import Calendar File…
 *
 * The same import a double-clicked file gets, for when Magical is already open and the
 * file is not in front of the user. Opening the picker is all this adds.
 */
async function handleImportFile(): Promise<void> {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const options = {
    title: uiString('dialog.importFile.title'),
    buttonLabel: uiString('dialog.importFile.button'),
    // `openFile` alone, and one at a time: each file is a separate question about which
    // account it belongs in, and a picker that allowed several would ask it repeatedly.
    properties: ['openFile' as const],
    filters: [{ name: uiString('dialog.importFile.filterName'), extensions: ['ics'] }],
  };

  const { canceled, filePaths } = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);

  if (canceled || filePaths.length === 0) return;
  await handleIcsFile(filePaths[0]);
}

/**
 * Imports one `.ics` file, whether it was double-clicked or chosen from the File menu.
 *
 * The account is always asked for when there is more than one, and never stands in from
 * the active account the way File → New Event allows: the file arrives from Finder or
 * Mail, with no account on screen to have been the one meant.
 */
async function handleIcsFile(filePath: string): Promise<void> {
  // A double-clicked file arrives with no window; the picker and the import need one.
  if (!accounts) createWindow();
  const manager = accounts;
  if (!manager) return;

  const text = readIcsFile(filePath);
  if (text === null) {
    await dialog.showMessageBox({
      type: 'error',
      message: uiString('dialog.ics.unreadable.message'),
      detail: uiString('dialog.ics.unreadable.detail', { file: path.basename(filePath) }),
    });
    return;
  }

  const summary = summariseIcs(text);
  const described = describeIcs(summary, path.basename(filePath));
  log.info(`Opened an .ics holding ${summary.eventCount} event(s)`);

  const account = await chooseEventAccount(manager, {
    title: uiString('dialog.ics.chooseAccount.title'),
    message: uiString('dialog.ics.chooseAccount.message'),
    detail: described,
    parentWindow: mainWindow,
    // A file arrives from outside the window with no account to have been the one
    // meant, so this asks whatever the picker setting says.
    forceAsk: true,
  });
  if (!account) return;

  const outcome = await manager.importIcsFile(account.id, filePath);
  await reportImport(outcome, account.name, summary.title);
}

/**
 * Tells the user what happened to the file they opened.
 *
 * A success is a banner, because the import is finished and there is nothing to decide.
 * Everything else is an alert: an unconfirmed import has left Google's own pane on
 * screen waiting for one click, and the user has to be told that is what they are
 * looking at.
 */
async function reportImport(
  outcome: IcsImportOutcome,
  accountName: string,
  title?: string,
): Promise<void> {
  if (outcome.kind === 'imported') {
    const what =
      outcome.imported === 1
        ? (title ?? uiString('notification.import.oneEvent'))
        : uiString('notification.import.events', {
            imported: outcome.imported,
            total: outcome.total,
          });
    dispatchNotice({
      key: `magical.import.${Date.now()}`,
      accountId: accounts?.getActiveAccountId() ?? '',
      title: uiString('dialog.ics.imported.title'),
      subtitle: accountName,
      body: what,
    });
    return;
  }

  if (outcome.kind === 'rejected') {
    await dialog.showMessageBox({
      type: 'warning',
      message: uiString('dialog.ics.rejected.message'),
      detail: outcome.message ?? uiString('dialog.ics.rejected.detail'),
    });
    return;
  }

  await dialog.showMessageBox({
    type: 'info',
    message: uiString('dialog.ics.finish.message'),
    detail: uiString('dialog.ics.finish.detail', {
      reason: outcome.reason,
      account: accountName,
    }),
  });
}

function handleSearch(query?: string, accountId?: string): void {
  if (!mainWindow) {
    createWindow();
  }

  const manager = accounts;
  if (!manager) return;

  if (accountId && accountId !== manager.getActiveAccountId()) {
    manager.switchAccount(accountId);
  }

  if (mainWindow) {
    app.focus({ steal: true });
    mainWindow.show();
    mainWindow.focus();
  }

  const trimmed = query?.trim();
  if (trimmed) {
    const activeView = manager.getActiveView();
    if (activeView && viewIsAlive(activeView)) {
      activeView.webContents.loadURL(
        `${CALENDAR_BASE_URL}/calendar/r/search?q=${encodeURIComponent(trimmed)}`,
      );
      activeView.webContents.focus();
    }
  } else {
    void manager.triggerCalendarAction('search');
    const activeView = manager.getActiveView();
    if (activeView && viewIsAlive(activeView)) {
      activeView.webContents.focus();
    }
  }
}

function handleToolbarAction(action: string, value: string): void {
  const manager = accounts;
  if (!manager) return;

  switch (action) {
    case 'switchAccount':
      manager.switchAccount(value);
      pushToolbarAccounts();
      applyMenu();
      break;

    case 'navPrev':
      void manager.triggerCalendarAction('navPrev');
      break;

    case 'navToday':
      void manager.triggerCalendarAction('navToday');
      break;

    case 'navNext':
      void manager.triggerCalendarAction('navNext');
      break;

    case 'goBack':
      // Back navigates out of subviews (settings, search, editor) or traverses history.
      log.info('Back from mouse side button or navigation shortcut');
      manager.goBack();
      break;

    case 'goForward':
      log.info('Forward from mouse side button or navigation shortcut');
      manager.goForward();
      break;

    case 'quickAdd':
      void handleNewEvent();
      break;

    case 'quickAddTask':
      void handleNewTask();
      break;

    case 'toggleSidebar':
      sidebarManager?.toggleSidebar();
      break;

    case 'sidebarSelectDate':
    case 'sidebarOpenEvent':
    case 'sidebarJoinCall':
    case 'sidebarDeleteEvent':
    case 'sidebarCompleteTask':
    case 'sidebarRsvp':
    case 'sidebarRefresh':
    case 'sidebarFilterChanged':
      sidebarManager?.handleSidebarAction(action, value);
      break;

    case 'search':
      handleSearch(value);
      break;

    case 'invitesReadAll':
      calendarService?.handleInvitesReadAll();
      break;

    case 'invite:yes':
    case 'invite:maybe':
    case 'invite:no':
    case 'invite:read':
    case 'invite:open':
      calendarService?.handleInviteAction(action, value);
      break;
  }
}

/**
 * Serves a reload request: Cmd+R, or Reload Calendar in the View menu.
 *
 * It rebuilds the window rather than the account view. A view rebuild is the cheaper
 * repair, and the right one when only the view's compositor has died, but it is what
 * failed on 29 October: twenty of them in twenty seconds, each attaching and
 * navigating a fresh view, with the window still blank until it was closed and
 * rebuilt. A reload request is a user asking for the calendar back, so it does the
 * repair that works rather than one that sometimes does.
 */
function reloadCalendar(): void {
  windowRebuilder.rebuild('reload requested');
}

function createWindow(
  initialAccountId?: string,
  options: { show?: boolean; bounds?: Rectangle } = {},
): void {
  log.info('Creating main window');
  // Built opaque from the start when transparency is off, rather than made
  // vibrant and corrected a frame later. Mirrors Magimail's createMainWindow.
  const settings = loadSettings();
  const isSidebarVisible = settings.sidebarVisible !== false;
  const initialMinW = windowMinWidth(isSidebarVisible);
  mainWindow = new BaseWindow(
    createMainWindowOptions({
      title: uiString('window.main.title'),
      width: isSidebarVisible ? 1470 : 1200,
      height: 850,
      minWidth: initialMinW,
      minHeight: CALENDAR_MIN_HEIGHT,
      // Set when this window is a replacement, so it returns to where the user had it.
      bounds: options.bounds,
      ...(settings.transparentBackground
        ? {}
        : {
            vibrancy: undefined as unknown as 'sidebar',
            visualEffectState: undefined as unknown as 'active',
            backgroundColor: getGoogleSurfaceColor(nativeTheme.shouldUseDarkColors),
          }),
    }),
  );

  attachNativeToolbar(mainWindow);

  sidebarManager = new SidebarManager(
    () => mainWindow,
    () => accounts,
    () => calendarService,
  );
  sidebarManager.onFilterChanged = () => menuBarManager?.pushUpdate();
  sidebarManager.attach(mainWindow);

  // Coming back to the window is the moment a stale agenda is most visible, and the
  // poller's own cadence is minutes long. `pollOnFocus` rate-limits this itself, so
  // switching between apps does not turn into a request per switch.
  mainWindow.on('focus', () => calendarService?.pollOnFocus());

  mainWindow.on('closed', () => {
    log.info('Main window closed');
    // Before the manager goes, so a relaunch restores the account that was last on
    // screen.
    accounts?.persistActiveAccount();
    // The account views outlive the window: nothing else closes them, so without
    // this they hold a renderer each until quit, and their suspend timers fire a few
    // minutes later against a destroyed window.
    accounts?.suspendAllAccounts();
    if (accounts) {
      accounts.onAccountsChanged = undefined;
      accounts.onAccountSwitched = undefined;
      accounts.onAccountRemoving = undefined;
      accounts.onModeChanged = undefined;
      accounts.onHistoryChanged = undefined;
      accounts.onCalendarIdsChanged = undefined;
    }
    findInPageController?.destroy();
    findInPageController = null;
    mainWindow = null;
    accounts = null;
    sidebarManager = null;
  });

  accounts = new AccountsManager(mainWindow, calendarPreloadPath(), { initialAccountId });

  // Coming back to the window is when a blank one is most likely to be seen, so the
  // pair is logged: it dates the failure against the suspension that preceded it.
  mainWindow.on('show', () => log.info('Main window shown'));
  mainWindow.on('hide', () => log.info('Main window hidden'));
  findInPageController = new FindInPageController(
    mainWindow,
    () => accounts?.getActiveView()?.webContents,
    uiString,
  );
  accounts.onAccountSwitched = () => {
    if (!accounts) return;
    findInPageController?.updateTarget();
    // The Back and Forward items are enabled from the account now in the window, and
    // so is the grid toolbar: each account keeps its own Calendar vs Tasks mode.
    applyMenu();
    setNativeToolbarMode(accounts.getActiveViewMode());
    sidebarManager?.updateAccounts(accounts.getAccounts());
  };
  // Removing an account has to purge what was cached for it before the record goes: the
  // poller sweep below only drops accounts that are already gone from the list.
  accounts.onAccountRemoving = (accountId) => calendarService?.forgetAccount(accountId);
  // The mode of the account on screen, so the toolbar dims `< Today >` and Search in
  // Tasks without the user having to touch anything first.
  accounts.onModeChanged = (mode) => setNativeToolbarMode(mode);
  // History moves without the account changing, and both items have to follow it.
  accounts.onHistoryChanged = () => applyMenu();
  accounts.onAccountsChanged = () => {
    if (!accounts) return;
    applyMenu();
    pushToolbarAccounts();
    // The dropdown belongs to the account in the window, so it follows the switch.
    calendarService?.setActiveAccount(accounts.getActiveAccountId());
    menuBarManager?.updateAccounts(accounts.getAccounts());
    sidebarManager?.updateAccounts(accounts.getAccounts());
    forgetAccountSettings(new Set(accounts.getAccounts().map((a) => a.id)));
    // An account that was just removed has to take its poller and its cached events with
    // it, or the agenda keeps drawing a diary whose filter row no longer exists. Cheap
    // when nothing changed, and it runs the prune that `syncPollers` owns.
    calendarService?.syncPollers();
    // Cheap, and it keeps an open settings window in step with the Accounts
    // menu. The helper ignores it when no window is showing.
    pushAccountsToSettings(accounts, calendarService?.getCachedEvents(), accountsNeedingSignIn());
  };
  accounts.onTimeframeChanged = (timeframe, dateStr) => {
    sidebarManager?.setTimeframe(timeframe, dateStr);
  };

  if (!menuBarManager) {
    menuBarManager = new MenuBarManager(
      () => mainWindow,
      () => accounts,
      () => calendarService,
      (targetAccountId) => void handleNewEvent(targetAccountId, true),
      openSettingsFromMenuBar,
      openAppFromMenuBar,
      (query, accountId) => handleSearch(query, accountId),
    );
  }
  menuBarManager.onHiddenCalendarsChanged = () => sidebarManager?.pushData();

  if (loadSettings().showMenuBarIcon) {
    menuBarManager.createTray();
    menuBarManager.updateAccounts(accounts.getAccounts());
    if (calendarService) {
      menuBarManager.updateEvents(calendarService.getCachedEvents());
    }
  }

  if (accounts) {
    sidebarManager?.updateAccounts(accounts.getAccounts());
  }
  if (calendarService) {
    sidebarManager?.updateEvents(calendarService.getCachedEvents());
  }

  pushToolbarAccounts();
  applyMenu();
  // A window built for an action stays in the background. It is told so explicitly because a window
  // created hidden fires no `hide`.
  if (options.show ?? true) mainWindow.show();
  else accounts?.handleWindowHidden();
}

app.whenReady().then(async () => {
  log.info('App ready');
  setUiLocale(app.getLocale());
  app.setAboutPanelOptions({
    applicationName: 'Magical',
    applicationVersion: app.getVersion(),
    copyright: 'Copyright © 2026 Alex Haslam',
    credits:
      'Not affiliated with Google LLC or Apple Inc. Google Calendar is a trademark of Google LLC. Mac and macOS are trademarks of Apple Inc.',
    website: WEBSITE_URL,
  });
  if (await enforcePrereleaseBuildExpiry()) return;
  logDisplayEnvironment();
  syncExtensionLogs(logDirectory());
  nativeTheme.themeSource = loadSettings().theme;
  // Before the settings window can be opened: the OS owns this value, and the
  // toggle has to show what macOS actually does, not what we last stored.
  reconcileLaunchAtLogin();

  // Google Calendar follows `prefers-color-scheme` whenever its own Appearance
  // setting is on "Device", and Electron drives that from `themeSource` — so
  // the theme syncs without injecting a filter over Google's own dark palette,
  // which is what Magimail has to do to Gmail.
  nativeTheme.on('updated', () => {
    accounts?.reinjectCss();
    // An opaque window paints a literal colour, so it has to follow the theme
    // itself — vibrancy would have tracked the appearance for free.
    const isTransparent = loadSettings().transparentBackground;
    if (!isTransparent) applyWindowTransparency(false);
    sidebarManager?.setTransparency(isTransparent, nativeTheme.shouldUseDarkColors);
  });

  onHelperEvent(handleHelperEvent);
  spawnHelper();
  onNativeToolbarAction(handleToolbarAction);
  initDock();

  // A cold launch can carry a magical:// link. It is read before the window exists
  // because the manager's constructor is what builds and loads an account's view, so
  // the account the link names has to be chosen first.
  const startupUrl =
    pendingProtocolUrl ?? process.argv.find((a) => a.startsWith(`${MAGICAL_PROTOCOL}://`)) ?? null;
  const startupAccountId = startupUrl ? accountIdFromLink(startupUrl) : undefined;
  if (startupUrl) {
    log.info(
      `Cold launch protocol URL detected: ${redactUrl(startupUrl)} ` +
        `targetAccount=${startupAccountId ?? 'none'}`,
    );
  }

  createWindow(startupAccountId);

  // After the window, because the service needs AccountsManager to navigate on a
  // notification click.
  startCalendarService();

  // A replacement helper is a blank one; re-populate its tray, notifications,
  // settings, and accounts when one spawns. Registered after startup so it runs
  // only for replacements.
  onHelperSpawned(() => {
    menuBarManager?.restoreTray();
    prepareNotifications();
    pushSettingsToHelper();
    if (accounts) {
      pushAccountsToSettings(accounts, calendarService?.getCachedEvents(), accountsNeedingSignIn());
    }
  });

  // Also after the window: an import needs the accounts and their partitions. Anything
  // `open-file` caught during launch is replayed here.
  onIcsFile((filePath) => void handleIcsFile(filePath));

  // Dispatch the startup protocol URL captured above, now that the account it named
  // is the one already loaded.
  if (startupUrl && accounts && calendarService) {
    log.info('Dispatching startup protocol URL:', redactUrl(startupUrl));
    dispatchProtocolUrl(startupUrl);
    pendingProtocolUrl = null;
  }

  // After the handler, so a launch that came from a double-clicked file imports it rather
  // than meeting a dialog about defaults first.
  void offerToBecomeDefault(mainWindow);

  powerMonitor.on('resume', () => {
    log.info('System resumed from sleep, refreshing calendar view');
    accounts?.reloadActive();
  });

  app.on('activate', () => {
    if (!mainWindow) createWindow();
    else mainWindow.show();
  });
});

app.on('before-quit', () => {
  quitting = true;
  log.info('App shutting down; terminating helper and suspending accounts');
  calendarService?.stop();
  menuBarManager?.destroyTray();
  killHelper();
  accounts?.persistActiveAccount();
  accounts?.suspendAllAccounts();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
