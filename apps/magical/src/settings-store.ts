import { app } from 'electron';
import { createLogger } from '@magimail/core/logger';
import { getDefaultBrowser, readSecretFile, writeSecretFile } from '@magimail/core';
import fs from 'node:fs';
import path from 'node:path';

const log = createLogger('Settings');

/** One calendar on one account, which is what it takes to name a calendar; the helper
 *  models the same pair as `CalendarRef` in `TrayModel.swift`. */
export interface CalendarRef {
  accountId: string;
  calendarId: string;
}

export interface MagicalSettings {
  theme: 'system' | 'light' | 'dark';
  launchAtLogin: boolean;
  /**
   * Which browser opens event links and browser-joined calls. `system` hands the URL to macOS.
   *
   * One setting for the app: the browser is where someone works, while the per-account
   * variable is the Chromium profile.
   */
  openLinksIn: string;
  transparentBackground: boolean;
  /** Hides Google's companion rail, the same thing Magimail's setting of this
   *  name hides in Gmail — both are `[role="complementary"]`. */
  hideSidebar: boolean;
  /**
   * Hides the top-right Calendar/Tasks switcher.
   *
   * Off by default; the full-screen Tasks view is Google's own page and Magical does
   * not style it, but hiding the switcher is the user's call. The companion rail's
   * Tasks icon still opens it directly either way.
   */
  hideTasksTab: boolean;
  addEventAccountPicker: 'ask' | 'active';
  /**
   * Minutes an account may sit inactive before its renderer is released.
   * 0 keeps every visited account loaded for the lifetime of the app.
   */
  inactiveAccountSuspendMinutes: number;
  /** Whether meeting alerts fire at all. */
  meetingAlertsEnabled: boolean;
  /** Minutes before a meeting starts to alert. */
  meetingAlertLeadMinutes: number;
  /**
   * Open Zoom and Teams calls in the browser rather than handing them to the native app.
   *
   * The native hand-off is the default because it skips a redirect and a prompt, but it
   * is wrong for anyone who is signed into the meeting's tenant in a browser profile and
   * not in the desktop client.
   */
  alwaysJoinInBrowser: boolean;
  /** Whether the native companion sidebar in the main window is visible. */
  sidebarVisible: boolean;
  /** Last active calendar timeframe mode (day, week, month, etc.). */
  lastTimeframe?: string;
  /** Last active anchor date string (yyyy-MM-dd). */
  lastDateStr?: string;
  /** Whether the mini calendar month grid in the menu bar tray is collapsed. */
  isCalendarCollapsed: boolean;
  /** Whether the menu bar status item is shown. */
  showMenuBarIcon: boolean;
  /** What is displayed next to the menu bar status item icon. */
  menuBarDisplayMode: 'nextEvent' | 'dayOfMonth' | 'dayAndMonth' | 'iconOnly';
  /** Tint the next event's bar in the menu bar with its account's colour. */
  showMenuBarAccountColor: boolean;
  /**
   * Calendars the user has hidden in the menu bar popover's filter.
   *
   * Held here rather than in the helper because the helper is restarted freely — on a
   * crash, on a rebuild — and a filter that forgets itself every time reads as broken.
   *
   * Each entry names the account as well as the calendar, because a calendar id does not
   * identify a calendar on its own: Google gives Birthdays, Tasks and each locale's
   * holidays the same id in every account.
   */
  hiddenCalendars: CalendarRef[];
  /**
   * Monotonic version of `hiddenCalendars`, bumped on every save.
   *
   * The menu bar popover and the companion sidebar run in different processes and each
   * toggles its own copy optimistically. Both receive the stored set on every push, so
   * without an order an update already in flight when the user toggles would undo it,
   * while a permanent "this session's choice wins" latch would ignore the other surface
   * for the rest of the run. Each surface applies a push only when the revision moves
   * forward.
   */
  hiddenCalendarsRevision: number;
  /**
   * Calendars the user has muted for meeting alerts and invitation banners.
   *
   * Held here rather than in the helper so alerts stay muted across restarts.
   * Empty by default, so every calendar raises alerts until explicitly turned off.
   *
   * Each entry is `accountId|calendarId` (`calendarAlertKey`), because Google gives
   * Birthdays, Tasks and each locale's holidays the same id in every account. A bare
   * calendar id is the older shape and still mutes in every account, so a mute saved
   * before the account was part of the key keeps working.
   */
  disabledAlertCalendarIds: string[];
  /**
   * What the Dock badge counts, mirroring Magimail's setting of the same name.
   *
   * `'allPending'` is every invitation still awaiting a reply. `'newInvitations'` is the
   * unread arrivals — what arrived while you were away and has not been answered or marked
   * read — leaving the backlog out. The setting reads as "All outstanding invitations" and
   * "Unread invitations"; the stored value keeps its original name. See
   * `docs/magical/rsvp.md#what-the-badge-counts`.
   */
  dockBadgeMode: 'allPending' | 'newInvitations';
  /**
   * Whether to offer, at launch, to become the app macOS opens `.ics` files with.
   *
   * Only the asking is stored. Whether Magical actually holds the type is read from
   * LaunchServices every time, because the user can change it in Finder and a remembered
   * answer would be wrong the moment they did.
   */
  askAboutDefaultCalendarApp: boolean;
  /** Whether to show completed tasks in the menu bar popover agenda and widgets. */
  showCompletedTasks: boolean;
  /**
   * The account that was on screen when the app last quit.
   *
   * Not a preference the user sets: it is the state a normal cold launch restores,
   * so a two-account install does not come back on whichever account happens to be
   * first in `accounts.json`. Empty means never recorded; an id that no longer names
   * an account is ignored rather than resurrected.
   */
  lastActiveAccountId: string;
}

const SETTINGS_FILENAME = 'settings.json';

const DEFAULT_SETTINGS: MagicalSettings = {
  theme: 'system',
  launchAtLogin: false,
  openLinksIn: 'system',
  transparentBackground: true,
  hideSidebar: false,
  hideTasksTab: false,
  addEventAccountPicker: 'active',
  inactiveAccountSuspendMinutes: 5,
  meetingAlertsEnabled: true,
  meetingAlertLeadMinutes: 5,
  alwaysJoinInBrowser: false,
  sidebarVisible: true,
  lastTimeframe: 'day',
  isCalendarCollapsed: false,
  showMenuBarIcon: true,
  menuBarDisplayMode: 'iconOnly',
  showMenuBarAccountColor: true,
  hiddenCalendars: [],
  hiddenCalendarsRevision: 0,
  disabledAlertCalendarIds: [],
  dockBadgeMode: 'allPending',
  askAboutDefaultCalendarApp: true,
  showCompletedTasks: true,
  lastActiveAccountId: '',
};

let cached: MagicalSettings | null = null;

/**
 * Set when settings.json is there and did not yield a value.
 *
 * The session then runs on defaults and writes nothing. A file that is only
 * unreadable still holds every preference the user has set; a keychain this build
 * cannot reach is the likeliest reason, and overwriting it loses them for good.
 */
let unreadable = false;

function settingsPath(): string {
  const userData =
    typeof app?.getPath === 'function' ? app.getPath('userData') : '/tmp/magical-settings';
  return path.join(userData, SETTINGS_FILENAME);
}

/** Unknown keys in the file are dropped, so a setting retired in a later build
 *  does not linger and quietly reappear. */
/** Whether one entry of a stored list is a shape a setting is allowed to hold. */
function isStoredListItem(item: unknown): boolean {
  if (typeof item === 'string') return true;
  if (typeof item !== 'object' || item === null) return false;
  const entry = item as Partial<CalendarRef>;
  return typeof entry.accountId === 'string' && typeof entry.calendarId === 'string';
}

export function mergeSettings(stored: unknown): MagicalSettings {
  const merged = { ...DEFAULT_SETTINGS };
  if (!stored || typeof stored !== 'object') return merged;

  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof MagicalSettings)[]) {
    const value = (stored as Record<string, unknown>)[key];
    if (value === undefined) continue;

    // `typeof` alone is not enough once a setting holds an array: `null` and `{}` are both
    // `'object'`, so a corrupt file would put either where a list belongs and every reader
    // would then have to defend itself.
    const fallback = DEFAULT_SETTINGS[key];
    if (Array.isArray(fallback)) {
      // Two shapes of list are stored: ids, and calendars named by account. Checking only
      // for strings silently emptied the second on every read, so the popover's filter
      // could be saved and never came back.
      if (Array.isArray(value) && value.every(isStoredListItem)) {
        (merged as Record<string, unknown>)[key] = value;
      }
      continue;
    }

    if (typeof value === typeof fallback) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

/**
 * The browser links open in before the user has chosen one.
 *
 * An install that never touched the setting adopts the Mac's default when we can launch
 * that browser with a profile, so an account's profile works without a second step.
 * Anything else stays `system`, which leaves the URL to macOS and keeps a domain owned by a
 * desktop app opening there.
 */
function defaultLinkBrowser(): string {
  const browser = getDefaultBrowser();
  return browser.isChromium ? browser.id : 'system';
}

export function loadSettings(): MagicalSettings {
  if (cached) return { ...cached };
  try {
    const stored = readSecretFile<unknown>(settingsPath());
    if (stored !== null) {
      const merged = mergeSettings(stored);
      // A settings file written before this setting existed has no `openLinksIn`, and `mergeSettings`
      // would give it the default `system`, which is indistinguishable from someone who chose to let
      // macOS decide. A fresh install should follow the Mac's browser, so that is filled in here.
      // Anything we cannot launch with a profile stays `system`.
      const storedChoice = (stored as Record<string, unknown>)?.openLinksIn;
      if (typeof storedChoice !== 'string') {
        merged.openLinksIn = defaultLinkBrowser();
      }
      cached = merged;
      return { ...cached };
    }
  } catch (err) {
    // Every preference is then back to factory, which the user cannot tell
    // apart from a fresh install.
    unreadable = true;
    log.error(
      'settings.json could not be read; every setting is back to its default and nothing will be saved this session:',
      err,
    );
  }
  cached = { ...DEFAULT_SETTINGS, openLinksIn: defaultLinkBrowser() };
  return { ...cached };
}

export function saveSetting<K extends keyof MagicalSettings>(
  key: K,
  value: MagicalSettings[K],
): MagicalSettings {
  const settings = loadSettings();
  settings[key] = value;
  cached = settings;

  if (unreadable) {
    log.error(
      `Not writing ${String(key)}: settings.json could not be read, and everything it still holds would be lost.`,
    );
    return { ...settings };
  }

  try {
    const file = settingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeSecretFile(file, settings);
  } catch (err) {
    // The write is allowed to fail — a restricted environment is not worth crashing over,
    // and the value is still live in memory for this session. Staying silent about it is
    // not: a setting that is kept until you quit and gone when you come back looks like a
    // setting nobody implemented, and nothing else in the app would ever say otherwise.
    log.error(
      `Could not write ${String(key)} to settings.json; it will not survive a restart:`,
      err,
    );
  }
  return { ...settings };
}
