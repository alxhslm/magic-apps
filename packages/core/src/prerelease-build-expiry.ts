/**
 * Pre-release builds expire after 90 days. There is no updater, and without an
 * expiry a build handed to someone works forever and looks the same as a
 * current one.
 *
 * Each pre-release bundle carries the timestamp it was compiled at, and the
 * main process refuses to start it once 90 days have passed. A stable release
 * is exempt: it ships an updater, and the updater replaces a stale build.
 * Either an updater or an expiry, not both.
 *
 * `docs/shared/licensing.md` describes the expiry under "Packaged builds
 * expire".
 */

import { WEBSITE_URL } from './constants.js';
import type { UiTranslator } from './ui-strings.js';

/** How long a pre-release build keeps working after it was compiled. */
export const PRERELEASE_BUILD_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export interface PrereleaseBuildCheck {
  /** Unix milliseconds stamped into the bundle at compile time. */
  builtAt: number;
  /** Current wall-clock Unix milliseconds. */
  now: number;
  /** The running app version, from `app.getVersion()`. */
  version: string;
  /** Whether this is a packaged install rather than a development run. */
  isPackaged: boolean;
}

// Semver core, optional pre-release tag, optional build metadata. Build
// metadata does not make a release a pre-release, so `1.0.0+build.1` is
// stable; a pre-release tag or a 0.x core is what expires.
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface ParsedVersion {
  major: number;
  prerelease: boolean;
}

/** Splits a semver string, or returns null when it is not one. */
function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(version.trim());
  if (!match) return null;
  return { major: Number.parseInt(match[1], 10), prerelease: match[4] !== undefined };
}

/**
 * A version is a pre-release while its major is 0 or it carries a semver
 * pre-release tag such as `1.0.0-beta.1`. The release workflow stamps the real
 * version into `package.json` before `build-app.sh` runs, so a tagged build
 * reads its own truth here.
 */
export function isPrereleaseVersion(version: string): boolean {
  const parsed = parseVersion(version);
  return parsed !== null && (parsed.major === 0 || parsed.prerelease);
}

/**
 * True when a packaged pre-release build has outlived its 90-day window.
 *
 * A development run never expires: `pnpm dev` rebuilds on every change, and a
 * stale checkout is not a tester handed a build.
 *
 * Everything else fails closed. A packaged build's version is always a real
 * semver from the release tag and every real build is stamped by tsup, so a
 * version this cannot read or a missing timestamp means the build itself is
 * broken — or the bundle was tampered with. `build-app.sh` refuses to package a
 * bundle whose stamp was not injected, so the remaining case is a mistake that
 * should be loud rather than a build that silently never expires.
 */
export function isPrereleaseBuildExpired({
  builtAt,
  now,
  version,
  isPackaged,
}: PrereleaseBuildCheck): boolean {
  if (!isPackaged) return false;
  const parsed = parseVersion(version);
  if (parsed === null) return true;
  if (parsed.major !== 0 && !parsed.prerelease) return false;
  if (!Number.isFinite(builtAt) || builtAt <= 0) return true;
  return now - builtAt > PRERELEASE_BUILD_LIFETIME_MS;
}

/**
 * The catalogue keys this message renders, so an app can assert they exist.
 */
export const PRERELEASE_EXPIRY_KEYS = [
  'dialog.expired.unreadableVersion',
  'dialog.expired.noTimestamp',
  'dialog.expired.expired',
  'dialog.expired.install',
] as const;

/**
 * The body of the modal alert shown when a pre-release build has expired, in
 * the form the main process hands to `dialog.showMessageBox`.
 *
 * Core owns the branches and the date; the wording comes from `t`, the app's
 * catalogue translator, because the app owns the language.
 */
export function prereleaseBuildExpiredMessage(
  { builtAt, version }: Pick<PrereleaseBuildCheck, 'builtAt' | 'version'>,
  t: UiTranslator,
): string {
  const install = t('dialog.expired.install', { url: WEBSITE_URL });
  if (parseVersion(version) === null) {
    return `${t('dialog.expired.unreadableVersion')} ${install}`;
  }
  if (!Number.isFinite(builtAt) || builtAt <= 0) {
    return `${t('dialog.expired.noTimestamp')} ${install}`;
  }
  const compiledOn = new Date(builtAt).toISOString().slice(0, 10);
  return `${t('dialog.expired.expired', { date: compiledOn })} ${install}`;
}
