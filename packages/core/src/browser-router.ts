import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { app, shell } from 'electron';
import { createLogger, redactUrl } from './logger.js';
import type { AccountConfig } from './account.js';

const log = createLogger('BrowserRouter');
const execFileAsync = promisify(execFile);

export interface BrowserOption {
  id: string;
  name: string;
  bundleId?: string;
  isChromium?: boolean;
}

export const SUPPORTED_BROWSERS: BrowserOption[] = [
  { id: 'system', name: 'System Default' },
  { id: 'chrome', name: 'Google Chrome', bundleId: 'com.google.Chrome', isChromium: true },
  { id: 'brave', name: 'Brave Browser', bundleId: 'com.brave.Browser', isChromium: true },
  { id: 'edge', name: 'Microsoft Edge', bundleId: 'com.microsoft.edgemac', isChromium: true },
  { id: 'safari', name: 'Safari', bundleId: 'com.apple.Safari', isChromium: false },
];

export interface ChromiumProfile {
  directory: string;
  name: string;
  email?: string;
  gaiaName?: string;
}

export const CHROMIUM_DATA_PATHS: Record<string, string> = {
  chrome: 'Library/Application Support/Google/Chrome/Local State',
  brave: 'Library/Application Support/BraveSoftware/Brave-Browser/Local State',
  edge: 'Library/Application Support/Microsoft Edge/Local State',
};

/** Where macOS records which application claims each URL scheme. */
const LAUNCH_SERVICES_PLIST =
  'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist';

/** macOS treats `https` as handled by Safari until something claims it. */
const UNCLAIMED_BUNDLE_ID = 'com.apple.Safari';

export interface DefaultBrowser {
  /** An id from `SUPPORTED_BROWSERS`, or `other` for a browser we cannot name. */
  id: string;
  /** The name macOS gives the application, e.g. `Firefox`. */
  name: string;
  bundleId: string;
  /** Only the three browsers in `CHROMIUM_DATA_PATHS` offer profile selection. */
  isChromium: boolean;
}

export interface DefaultBrowserOptions {
  customHome?: string;
  /** Returns the LaunchServices plist as JSON. Injectable for testing. */
  readPlistJson?: (plistPath: string) => string;
}

/**
 * Reports the browser macOS opens `https` links with.
 *
 * The settings tab preselects this so a user who has never touched the picker sees which
 * browser links actually open in, and gets the profile picker when that browser is one of
 * ours. Reading it here rather than in the helper keeps `SUPPORTED_BROWSERS` the only list
 * mapping a bundle identifier to a browser id.
 */
export function getDefaultBrowser(options: DefaultBrowserOptions = {}): DefaultBrowser {
  const bundleId = readDefaultBrowserBundleId(options);
  const known = SUPPORTED_BROWSERS.find(
    (b) => b.bundleId !== undefined && b.bundleId.toLowerCase() === bundleId.toLowerCase(),
  );

  if (known) {
    return {
      id: known.id,
      name: known.name,
      bundleId: known.bundleId ?? bundleId,
      isChromium: known.isChromium === true,
    };
  }

  // A browser outside the list (Firefox, Arc, a Chromium fork we do not read profiles for).
  return {
    id: 'other',
    name: defaultHandlerName() ?? bundleId,
    bundleId,
    isChromium: false,
  };
}

function readDefaultBrowserBundleId(options: DefaultBrowserOptions): string {
  const read = options.readPlistJson ?? readLaunchServicesJson;
  const home = options.customHome ?? os.homedir();

  // An absent plist or an absent `https` entry is the ordinary state of a Mac that has
  // never changed its default browser, not a fault worth a log line.
  try {
    const parsed = JSON.parse(read(path.join(home, LAUNCH_SERVICES_PLIST)));
    const handlers: unknown = parsed?.LSHandlers;
    if (!Array.isArray(handlers)) return UNCLAIMED_BUNDLE_ID;

    // `All` is set when the browser was chosen for every role; `Viewer` when the user
    // changed only what opens documents, which is the only row System Settings shows.
    const forHttps = handlers.filter((h) => h && h.LSHandlerURLScheme === 'https');
    const entry =
      forHttps.find((h) => typeof h.LSHandlerRoleAll === 'string') ??
      forHttps.find((h) => typeof h.LSHandlerRoleViewer === 'string');

    const bundleId = entry?.LSHandlerRoleAll ?? entry?.LSHandlerRoleViewer;
    return typeof bundleId === 'string' && bundleId ? bundleId : UNCLAIMED_BUNDLE_ID;
  } catch {
    return UNCLAIMED_BUNDLE_ID;
  }
}

function readLaunchServicesJson(plistPath: string): string {
  // The plist is binary, and `plutil` is how macOS converts one without a parser here.
  return execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf-8',
  });
}

function defaultHandlerName(): string | undefined {
  try {
    return app.getApplicationNameForProtocol('https://') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads all detected profiles for every supported Chromium browser.
 */
export function getAllChromiumProfiles(customHome?: string): Record<string, ChromiumProfile[]> {
  return {
    chrome: getChromiumProfiles('chrome', customHome),
    brave: getChromiumProfiles('brave', customHome),
    edge: getChromiumProfiles('edge', customHome),
  };
}

/**
 * Reads the list of user profiles from Chromium's Local State file on macOS.
 */
export function getChromiumProfiles(browserId: string, customHome?: string): ChromiumProfile[] {
  const relativePath = CHROMIUM_DATA_PATHS[browserId];
  if (!relativePath) return [];

  const home = customHome ?? os.homedir();
  const filePath = path.join(home, relativePath);

  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    const infoCache = parsed?.profile?.info_cache;
    if (!infoCache || typeof infoCache !== 'object') return [];

    const profiles: ChromiumProfile[] = [];
    for (const [dir, data] of Object.entries(infoCache)) {
      if (!data || typeof data !== 'object') continue;
      const profileData = data as Record<string, unknown>;
      profiles.push({
        directory: dir,
        name: typeof profileData.name === 'string' && profileData.name ? profileData.name : dir,
        email:
          typeof profileData.user_name === 'string' && profileData.user_name
            ? profileData.user_name
            : undefined,
        gaiaName:
          typeof profileData.gaia_name === 'string' && profileData.gaia_name
            ? profileData.gaia_name
            : undefined,
      });
    }

    return profiles.sort((a, b) => {
      if (a.directory === 'Default') return -1;
      if (b.directory === 'Default') return 1;
      return a.name.localeCompare(b.name);
    });
  } catch (err) {
    log.warn(`Could not read profiles for ${browserId}:`, err);
    return [];
  }
}

/**
 * Resolves the target Chromium profile directory name for an account.
 *
 * If explicit setting is provided (and not `_auto`), uses that if available.
 * If set to `_auto` (or omitted), matches the account email against user_name.
 */
export function resolveChromiumProfile(
  browserId: string,
  profileSetting?: string,
  accountEmail?: string,
  customHome?: string,
): string | null {
  const profiles = getChromiumProfiles(browserId, customHome);
  if (profiles.length === 0) return null;

  if (profileSetting && profileSetting !== '_auto') {
    const found = profiles.find((p) => p.directory === profileSetting);
    return found ? found.directory : null;
  }

  if (accountEmail) {
    const normalizedEmail = accountEmail.trim().toLowerCase();
    const matched = profiles.find((p) => p.email?.trim().toLowerCase() === normalizedEmail);
    if (matched) return matched.directory;
  }

  const defaultProfile = profiles.find((p) => p.directory === 'Default');
  return defaultProfile?.directory ?? profiles[0]?.directory ?? null;
}

export interface OpenExternalUrlOptions {
  account?: Pick<AccountConfig, 'browser' | 'browserProfile' | 'email'>;
  /** Injectable runner for /usr/bin/open commands, mainly for testing. */
  openCommandRunner?: (args: string[]) => Promise<void>;
  /** Injectable shell.openExternal fallback. */
  fallbackOpenExternal?: (url: string) => Promise<void>;
  /** Custom home dir for profile reading (testing). */
  customHome?: string;
}

/**
 * Opens an external URL in the designated browser and profile for an account.
 *
 * If the account specifies 'system' or an unknown browser, delegates to shell.openExternal.
 * If a Chromium browser is selected, launches via /usr/bin/open with --profile-directory.
 * If an error occurs, falls back gracefully to system default.
 */
export async function openExternalUrl(
  url: string,
  options: OpenExternalUrlOptions = {},
): Promise<void> {
  const fallback =
    options.fallbackOpenExternal ??
    (async (u: string) => {
      await shell.openExternal(u);
    });

  // Non-web schemes (e.g. mailto:, x-apple.systempreferences:) go to system default directly
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    await fallback(url);
    return;
  }

  const browserId = options.account?.browser ?? 'system';
  const browserDef = SUPPORTED_BROWSERS.find((b) => b.id === browserId);

  const runner =
    options.openCommandRunner ??
    (async (args: string[]) => {
      await execFileAsync('/usr/bin/open', args);
    });

  if (!browserDef || browserId === 'system' || !browserDef.bundleId) {
    await fallback(url);
    return;
  }

  try {
    if (browserDef.isChromium) {
      const profileDir = resolveChromiumProfile(
        browserId,
        options.account?.browserProfile,
        options.account?.email,
        options.customHome,
      );

      if (profileDir) {
        log.info(`Opening ${redactUrl(url)} in ${browserDef.name} (profile: ${profileDir})`);
        await runner([
          '-b',
          browserDef.bundleId,
          '-n',
          '--args',
          `--profile-directory=${profileDir}`,
          url,
        ]);
        return;
      }

      log.info(`Opening ${redactUrl(url)} in ${browserDef.name} (default profile)`);
      await runner(['-b', browserDef.bundleId, url]);
      return;
    }

    // Non-Chromium browser (e.g. Safari)
    log.info(`Opening ${redactUrl(url)} in ${browserDef.name}`);
    await runner(['-b', browserDef.bundleId, url]);
  } catch (err) {
    log.warn(`Failed to open in ${browserDef.name}, falling back to system default:`, err);
    await fallback(url);
  }
}
