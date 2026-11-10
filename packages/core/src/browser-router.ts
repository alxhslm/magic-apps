import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { app, shell } from 'electron';
import { createLogger, redactUrl } from './logger.js';
import { APP_BUNDLE_IDS, crossAppLink } from './cross-app.js';
import { unwrapRedirectors, toNativeMeetingUrl } from './links.js';
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
  { id: 'firefox', name: 'Firefox', bundleId: 'org.mozilla.firefox', isChromium: false },
];

/**
 * How a browser id should be written in our own sentences.
 *
 * `system` is not a browser, so it reads as "your browser"; an id we do not know falls back to the
 * id itself rather than to nothing, because a wrong name is more useful than a blank one.
 */
export function browserDisplayName(browserId: string): string {
  if (!browserId || browserId === 'system') return 'your browser';
  return SUPPORTED_BROWSERS.find((b) => b.id === browserId)?.name ?? browserId;
}

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
  /** The name macOS gives the application, e.g. `Arc`. */
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
 * Reports the browser macOS opens `https` links with. The settings tab preselects it, and the
 * profile picker reads it, so `SUPPORTED_BROWSERS` stays the only bundle-id mapping.
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

  // A browser outside the list (Arc, Orion, a Chromium fork we do not read profiles for).
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

/**
 * Whether an application is installed, asked of LaunchServices by bundle id.
 *
 * Not by asking who handles the app's URL scheme: `URLForApplicationToOpenURL` answers `nil`
 * for a custom scheme even where the app is installed, so the scheme question would leave every
 * deep link looking unowned.
 */
const INSTALLED_SCRIPT = `function run(argv) {
  ObjC.import('AppKit');
  const app = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(argv[0]);
  return app ? app.path.js : '';
}`;

async function isAppInstalled(bundleId: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      INSTALLED_SCRIPT,
      bundleId,
    ]);
    return stdout.trim().length > 0;
  } catch (err) {
    log.warn(`Could not check whether ${bundleId} is installed:`, err);
    return false;
  }
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
 * Reads the profile list and last-used profile together, since both live in Local State and
 * resolving a profile needs both.
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

/** The profile the browser was last working in, which is the one its open window shows. */
export function getLastUsedProfile(browserId: string, customHome?: string): string | null {
  const { profiles, lastUsed } = readChromiumLocalState(browserId, customHome);
  return profiles.some((p) => p.directory === lastUsed) ? (lastUsed ?? null) : null;
}

/**
 * Resolves the Chromium profile directory an account's links should open in.
 *
 * An explicit directory is used while the browser still has it. `_auto` and an unset setting mean
 * the profile signed in as the account; where none carries that address the answer is `null`, so
 * the launch line keeps no `--profile-directory` and Chromium opens in its current profile.
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
  /** Whether another app is installed. Injectable so a test does not need it to be. */
  isAppInstalled?: (bundleId: string) => Promise<boolean>;
  /**
   * LaunchServices check for native custom schemes (Zoom, Teams, etc.).
   * If provided and the URL is rewritten to a native scheme, checks whether
   * an app is installed before attempting to launch it via shell.openExternal.
   */
  hasApplicationForUrl?: (url: string) => boolean;
  /**
   * Optional custom URL rewrite hook before opening (defaults to toNativeMeetingUrl).
   */
  rewriteUrl?: (url: string) => string;
}

/**
 * Opens an external URL for an account in the chosen browser, with the account's Chromium profile
 * where one resolves. `system` and unknown browsers go to `shell.openExternal`.
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

  const unwrappedUrl = unwrapRedirectors(url);

  if (options.hasApplicationForUrl) {
    const target = options.rewriteUrl
      ? options.rewriteUrl(unwrappedUrl)
      : toNativeMeetingUrl(unwrappedUrl);

    if (target !== unwrappedUrl) {
      const scheme = target.split(':')[0];
      if (options.hasApplicationForUrl(target)) {
        try {
          await fallback(target);
          return;
        } catch (err) {
          log.warn(`${scheme}: refused the request, opening in the browser:`, err);
        }
      } else {
        log.info(`No application for ${scheme}:, opening in the browser`);
      }
    }
  }

  const destinationUrl = unwrappedUrl;

  // Non-web schemes (e.g. mailto:, x-apple.systempreferences:) go to system default directly
  if (!destinationUrl.startsWith('http://') && !destinationUrl.startsWith('https://')) {
    await fallback(destinationUrl);
    return;
  }

  const browserId = options.browser ?? 'system';
  const browserDef = SUPPORTED_BROWSERS.find((b) => b.id === browserId);

  const runner =
    options.openCommandRunner ??
    (async (args: string[]) => {
      await execFileAsync('/usr/bin/open', args);
    });

  // The other app's own web interface belongs in that app, which already shows the same data.
  // Only offered when that app is installed, because a deep link nobody handles leaves the
  // user on an error page where a browser tab would have worked.
  const crossApp = crossAppLink(url);
  const appInstalled = options.isAppInstalled ?? isAppInstalled;
  if (crossApp && (await appInstalled(APP_BUNDLE_IDS[crossApp.scheme]).catch(() => false))) {
    let targetLink = crossApp.deepLink;
    if (options.account?.email) {
      try {
        const parsed = new URL(targetLink);
        if (!parsed.searchParams.has('account')) {
          parsed.searchParams.set('account', options.account.email);
          targetLink = parsed.toString();
        }
      } catch {
        // Leave targetLink untouched if URL parsing fails
      }
    }
    log.info(`Opening ${redactUrl(url)} in ${crossApp.scheme} (${targetLink})`);
    await fallback(targetLink);
    return;
  }

  // Anything we cannot launch ourselves goes to macOS, which is also what keeps a domain
  // owned by a desktop app (Universal Links) out of the browser.
  if (!browserDef || !browserDef.bundleId) {
    await fallback(destinationUrl);
    return;
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
      // costs a second instance. An automatic answer that resolves to the profile already
      // open is handed over without the flag, which reuses that window.
      //
      // An account that names a profile always gets it. "The profile already open" is
      // whichever one we launched last, so treating that as a match let one account's link
      // pull the next account's link into its window.
      const wanted = options.account?.browserProfile;
      const isChosen = Boolean(wanted && wanted !== AUTO_PROFILE);
      if (profileDir && (isChosen || profileDir !== lastUsed)) {
        log.info(
          `Opening ${redactUrl(destinationUrl)} in ${browserDef.name} (profile: ${profileDir})`,
        );
        await runner([
          '-b',
          browserDef.bundleId,
          '-n',
          '--args',
          `--profile-directory=${profileDir}`,
          destinationUrl,
        ]);
        return;
      }

      log.info(`Opening ${redactUrl(destinationUrl)} in ${browserDef.name} (current profile)`);
      await runner(['-b', browserDef.bundleId, destinationUrl]);
      return;
    }

    // Non-Chromium browser (e.g. Safari)
    log.info(`Opening ${redactUrl(destinationUrl)} in ${browserDef.name}`);
    await runner(['-b', browserDef.bundleId, destinationUrl]);
  } catch (err) {
    log.warn(`Failed to open in ${browserDef.name}, falling back to system default:`, err);
    await fallback(destinationUrl);
  }
}
