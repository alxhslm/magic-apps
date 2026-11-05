import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { app, shell } from 'electron';
import { createLogger, redactUrl } from './logger.js';
import {
  appForUrl,
  appLinkDecision,
  hostOf,
  type AppLink,
  type AppLinkMode,
  type AppLinkOverrides,
} from './app-links.js';
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
  // Routing asks this per external link, and a LaunchServices read is a subprocess. The
  // Mac's default browser changes when the user changes it, not between two clicks, so a
  // short cache costs nothing and keeps a link from waiting on `plutil`.
  const cacheable = options.customHome === undefined && options.readPlistJson === undefined;
  if (cacheable && defaultBrowserCache && Date.now() - defaultBrowserCache.at < 30_000) {
    return defaultBrowserCache.value;
  }

  const browser: DefaultBrowser = detectDefaultBrowser(options);
  if (cacheable) defaultBrowserCache = { at: Date.now(), value: browser };
  return browser;
}

let defaultBrowserCache: { at: number; value: DefaultBrowser } | undefined;

function detectDefaultBrowser(options: DefaultBrowserOptions): DefaultBrowser {
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

/** Match the account's own email address against the browser's profiles. */
export const AUTO_PROFILE = '_auto';
/** Never pass a profile: hand the URL over and let the browser use the window it has. */
export const NO_PROFILE = '_none';
interface ChromiumLocalState {
  profiles: ChromiumProfile[];
  lastUsed?: string;
}

/**
 * Reads Chromium's Local State once for both the profile list and the last profile used.
 *
 * The two live in the same file, and resolving a profile needs both, so reading them apart
 * meant parsing the same JSON twice per link.
 */
function readChromiumLocalState(browserId: string, customHome?: string): ChromiumLocalState {
  const relativePath = CHROMIUM_DATA_PATHS[browserId];
  if (!relativePath) return { profiles: [] };

  const home = customHome ?? os.homedir();
  const filePath = path.join(home, relativePath);

  try {
    if (!fs.existsSync(filePath)) return { profiles: [] };
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    const infoCache = parsed?.profile?.info_cache;
    if (!infoCache || typeof infoCache !== 'object') return { profiles: [] };

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

    profiles.sort((a, b) => {
      if (a.directory === 'Default') return -1;
      if (b.directory === 'Default') return 1;
      return a.name.localeCompare(b.name);
    });

    const lastUsed =
      typeof parsed?.profile?.last_used === 'string' ? parsed.profile.last_used : undefined;

    return { profiles, lastUsed };
  } catch (err) {
    log.warn(`Could not read profiles for ${browserId}:`, err);
    return { profiles: [] };
  }
}

/**
 * Reads the list of user profiles from Chromium's Local State file on macOS.
 */
export function getChromiumProfiles(browserId: string, customHome?: string): ChromiumProfile[] {
  return readChromiumLocalState(browserId, customHome).profiles;
}

/**
 * The profile the browser was last working in, which is the one its open window shows.
 */
export function getLastUsedProfile(browserId: string, customHome?: string): string | null {
  const { profiles, lastUsed } = readChromiumLocalState(browserId, customHome);
  return profiles.some((p) => p.directory === lastUsed) ? (lastUsed ?? null) : null;
}

/**
 * Resolves the Chromium profile directory an account's links should open in.
 *
 * An explicit directory is used when the browser still has it. `_auto` and an unset setting
 * both mean "the profile signed in as the account", and nothing more: where no profile
 * carries that address the answer is `null`, which leaves `--profile-directory` off the
 * launch line and lets Chromium do what it does with any URL, which is open it in the
 * profile it is already working in. Naming `Default` there would send the link to a profile
 * the user may never touch.
 */
export function resolveChromiumProfile(
  browserId: string,
  profileSetting?: string,
  accountEmail?: string,
  customHome?: string,
): string | null {
  if (profileSetting === NO_PROFILE) return null;

  const { profiles } = readChromiumLocalState(browserId, customHome);
  if (profiles.length === 0) return null;

  if (profileSetting && profileSetting !== AUTO_PROFILE) {
    const found = profiles.find((p) => p.directory === profileSetting);
    return found ? found.directory : null;
  }

  if (accountEmail) {
    const normalizedEmail = accountEmail.trim().toLowerCase();
    const matched = profiles.find((p) => p.email?.trim().toLowerCase() === normalizedEmail);
    if (matched) return matched.directory;
  }

  return null;
}

export interface OpenExternalUrlOptions {
  /**
   * The app's choice of browser, from settings. `system` hands the URL to macOS, which is
   * what an install that never touched the setting does.
   */
  browser?: string;
  /** The account, for the profile its links should open in. */
  account?: Pick<AccountConfig, 'browserProfile' | 'email'>;
  /** Injectable runner for /usr/bin/open commands, mainly for testing. */
  openCommandRunner?: (args: string[]) => Promise<void>;
  /** Injectable shell.openExternal fallback. */
  fallbackOpenExternal?: (url: string) => Promise<void>;
  /** Custom home dir for profile reading (testing). */
  customHome?: string;
  /** Whether a domain owned by a desktop app opens there, asks first, or always uses the browser. */
  appLinks?: AppLinkMode;
  /** Answers the user has already given, keyed by host. */
  appLinkOverrides?: AppLinkOverrides;
  /** Asks the user about a link the table says belongs to an app. */
  askAboutAppLink?: (
    app: AppLink,
    host: string,
  ) => Promise<{ choice: 'app' | 'browser'; remember: boolean }>;
  /**
   * The Mac's default browser id, when the caller already knows it. Injectable so a test does
   * not depend on which browser the machine running it has.
   */
  defaultBrowserId?: string;
}

/**
 * Opens an external URL in the designated browser and profile for an account.
 *
 * If the browser is 'system' or not one we know, delegates to shell.openExternal.
 * If a Chromium browser is selected, launches via /usr/bin/open with --profile-directory,
 * which is the only way an account's profile can be honoured.
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

  const browserId = options.browser ?? 'system';
  const browserDef = SUPPORTED_BROWSERS.find((b) => b.id === browserId);

  const runner =
    options.openCommandRunner ??
    (async (args: string[]) => {
      await execFileAsync('/usr/bin/open', args);
    });

  // Anything we cannot launch ourselves goes to macOS, which is also what keeps a domain
  // owned by a desktop app (Universal Links) out of the browser.
  if (!browserDef || !browserDef.bundleId) {
    await fallback(url);
    return;
  }

  // A domain in the curated table belongs to a desktop app: `open -b` hands the URL to it. Every
  // other link goes to the browser, which is what makes the account's profile apply, and the
  // table exists because that hand-off cannot be discovered for itself.
  const owningApp = appForUrl(url);
  if (owningApp) {
    const host = hostOf(url) ?? '';
    const { useApp } = await appLinkDecision(
      owningApp,
      host,
      options.appLinks ?? 'auto',
      options.appLinkOverrides,
      options.askAboutAppLink,
    );

    if (useApp) {
      try {
        log.info(`Opening ${redactUrl(url)} in ${owningApp.name} (${owningApp.bundleId})`);
        await runner(['-b', owningApp.bundleId, url]);
        return;
      } catch (err) {
        log.warn(`${owningApp.name} did not accept ${redactUrl(url)}, opening in a browser:`, err);
      }
    }
  }

  try {
    if (browserDef.isChromium) {
      const lastUsed = getLastUsedProfile(browserId, options.customHome);
      const profileDir = resolveChromiumProfile(
        browserId,
        options.account?.browserProfile,
        options.account?.email,
        options.customHome,
      );

      // Chromium reads --profile-directory only when it is starting, so naming a profile
      // costs a second instance. Where the answer is the profile already open there is
      // nothing to gain from that, and the URL goes to macOS instead.
      //
      // macOS rather than `-b`: LaunchServices also hands a URL to a desktop app that claims
      // the domain, which starting the browser by hand would bypass. When the browser we want
      // is the Mac's default, letting macOS route it costs nothing and keeps that.
      //
      // An account that names a profile always gets it. "The profile already open" is
      // whichever one we launched last, so treating that as a match let one account's link
      // pull the next account's link into its window.
      const wanted = options.account?.browserProfile;
      const isChosen = Boolean(wanted && wanted !== AUTO_PROFILE);
      if (profileDir && (isChosen || profileDir !== lastUsed)) {
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

      log.info(`Opening ${redactUrl(url)} in ${browserDef.name} (current profile)`);
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
