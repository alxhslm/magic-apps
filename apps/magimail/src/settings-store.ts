import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { readSecretFile, writeSecretFile } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('Settings');

export interface AppSettings {
  theme: 'system' | 'light' | 'dark';
  launchAtLogin: boolean;
  dockBadgeMode: DockBadgeMode;
  showMenuBarTray: boolean;
  menuBarShowCount: boolean;
  menuBarShowDots: boolean;
  menuBarUnreadOnly: boolean;
  hidePromotionAds: boolean;
  hideSidebar: boolean;
  transparentBackground: boolean;
  pollIntervalSeconds: number;
  pollIntervalBatterySeconds: number;
  /**
   * Minutes an account may sit inactive before its renderer is released.
   * 0 keeps every visited account loaded for the lifetime of the app.
   */
  inactiveAccountSuspendMinutes: number;
  composeAccountPicker: 'ask' | 'active';
  quickComposeHotkey: QuickComposeChord;
  dismissedApiPrompts: string[];
  /**
   * The account that was on screen when the app last quit.
   *
   * Not a preference the user sets: it is the state a normal cold launch restores,
   * so a multi-account install does not come back on whichever account happens to be
   * first in `accounts.json`. Empty means never recorded; an id that no longer names
   * an account is ignored rather than resurrected.
   */
  lastActiveAccountId: string;
  notifications: {
    primary: string;
    updates: string;
    promotions: string;
    social: string;
    forums: string;
  };
}

/**
 * Chords the quick compose hotkey may hold, as Electron accelerators. Every one
 * is C and only the modifiers vary; `off` is an entry here rather than a separate
 * toggle that could disagree with it.
 */
export const QUICK_COMPOSE_CHORDS = [
  'off',
  'Alt+Command+C',
  'Control+Command+C',
  'Shift+Command+C',
  'Control+Alt+Command+C',
] as const;

export type QuickComposeChord = (typeof QUICK_COMPOSE_CHORDS)[number];

export const DEFAULT_QUICK_COMPOSE_CHORD: QuickComposeChord = 'Alt+Command+C';

/**
 * What the dock badge counts.
 *
 * `allUnread` is the whole unread backlog — the state of the inbox right now.
 * `newArrivals` is the iOS Mail model: only mail that arrived while you were
 * away and that you have not dealt with yet, so a permanently unread backlog
 * never enters the number. See `docs/magimail/notifications.md#what-the-dock-badge-counts`.
 *
 * The switcher and the menu bar are unaffected by this, deliberately. They are
 * triage surfaces answering "what state is each inbox in", which only the
 * backlog can answer; the badge is an interruption, which is the thing worth
 * making optional.
 */
export const DOCK_BADGE_MODES = ['allUnread', 'newArrivals', 'off'] as const;

export type DockBadgeMode = (typeof DOCK_BADGE_MODES)[number];

const SETTINGS_FILENAME = 'settings.json';

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  launchAtLogin: false,
  dockBadgeMode: 'allUnread',
  showMenuBarTray: true,
  menuBarShowCount: true,
  menuBarShowDots: true,
  menuBarUnreadOnly: false,
  hidePromotionAds: true,
  hideSidebar: false,
  transparentBackground: true,
  pollIntervalSeconds: 60,
  pollIntervalBatterySeconds: 180,
  inactiveAccountSuspendMinutes: 5,
  composeAccountPicker: 'active',
  quickComposeHotkey: DEFAULT_QUICK_COMPOSE_CHORD,
  dismissedApiPrompts: [],
  lastActiveAccountId: '',
  notifications: {
    primary: 'loud',
    updates: 'silent',
    promotions: 'badge',
    social: 'badge',
    forums: 'off',
  },
};

let cachedSettings: AppSettings | null = null;

/**
 * True once settings.json existed and yielded nothing.
 *
 * The session then runs on defaults and never writes the file back: a file
 * that would not read is still every preference the user has set, and
 * replacing it with a factory-fresh one is the one outcome nothing recovers
 * from.
 */
let settingsUnreadable = false;

function getSettingsPath(): string {
  const userData =
    typeof app?.getPath === 'function' ? app.getPath('userData') : '/tmp/magimail-settings';
  return path.join(userData, SETTINGS_FILENAME);
}

/**
 * Carries a pre-mode settings file across to `dockBadgeMode`.
 *
 * `showDockBadge` was a boolean, and its `false` is the only state the mode
 * cannot infer from its own default. The old key is dropped rather than kept in
 * sync: two spellings of one setting is how they end up disagreeing.
 */
function migrateDockBadge(data: Record<string, unknown>): Record<string, unknown> {
  const { showDockBadge, ...rest } = data;
  if (rest.dockBadgeMode === undefined && showDockBadge === false) {
    rest.dockBadgeMode = 'off';
  }
  return rest;
}

export function loadSettings(): AppSettings {
  if (cachedSettings) return { ...cachedSettings };
  try {
    const stored = readSecretFile<Record<string, unknown>>(getSettingsPath());
    if (stored) {
      cachedSettings = { ...DEFAULT_SETTINGS, ...migrateDockBadge(stored) } as AppSettings;
      return { ...cachedSettings };
    }
  } catch (err) {
    settingsUnreadable = true;
    // Every preference is then back to factory, which the user cannot tell
    // apart from a fresh install.
    log.error('settings.json could not be read; every setting is back to its default:', err);
  }
  cachedSettings = { ...DEFAULT_SETTINGS };
  return { ...cachedSettings };
}

export function saveSetting(key: string, value: unknown): AppSettings {
  const settings = loadSettings();
  const parts = key.split('.');

  // The Swift settings window sends keys by name, so a misspelling arrives
  // here as a plausible-looking string. Writing it puts dead weight in
  // settings.json and leaves the toggle doing nothing, with nothing logged.
  if (!(parts[0] in settings)) {
    log.warn(`Ignoring unknown setting ${key}`);
    return { ...settings };
  }

  log.info(`Setting ${key} = ${String(value)}`);
  if (parts.length === 2) {
    const [group, subKey] = parts;
    (settings as unknown as Record<string, Record<string, unknown>>)[group][subKey] = value;
  } else {
    (settings as unknown as Record<string, unknown>)[key] = value;
  }
  cachedSettings = settings;
  if (settingsUnreadable) {
    log.error(
      `${key} is held for this session only: settings.json did not read back, so it is left as it is.`,
    );
    return settings;
  }
  try {
    const filePath = getSettingsPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    writeSecretFile(filePath, settings);
  } catch (err) {
    // The write is allowed to fail -- a restricted environment is not worth
    // crashing over, and the value is live in memory for this session. Staying
    // silent about it is not: a setting kept until you quit and gone when you
    // come back looks like a setting nobody implemented.
    log.error(`Could not write ${key} to settings.json; it will not survive a restart:`, err);
  }
  return settings;
}
