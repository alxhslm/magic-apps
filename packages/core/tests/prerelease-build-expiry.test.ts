import { describe, it, expect } from 'vitest';
import {
  PRERELEASE_BUILD_LIFETIME_MS,
  PRERELEASE_EXPIRY_KEYS,
  isPrereleaseBuildExpired,
  isPrereleaseVersion,
  prereleaseBuildExpiredMessage,
} from '../src/prerelease-build-expiry.js';
import type { UiTranslator } from '../src/ui-strings.js';

const DAY = 24 * 60 * 60 * 1000;
const BUILT_AT = Date.UTC(2026, 0, 1);

/** The English wording the app supplies, with core's date and URL filled in. */
const t: UiTranslator = (key, params) => {
  switch (key) {
    case 'dialog.expired.unreadableVersion':
      return 'This build’s version could not be read, so it is no longer supported.';
    case 'dialog.expired.noTimestamp':
      return 'This pre-release build carries no valid build timestamp, so it is no longer supported.';
    case 'dialog.expired.expired':
      return `This pre-release build was compiled on ${params?.date} and has passed its 90-day expiry, so it is no longer supported.`;
    case 'dialog.expired.install':
      return `Install a current build from ${params?.url} to keep using the app.`;
    default:
      throw new Error(`unexpected key ${key}`);
  }
};

describe('isPrereleaseVersion', () => {
  it('treats every 0.x version as a pre-release', () => {
    expect(isPrereleaseVersion('0.0.0')).toBe(true);
    expect(isPrereleaseVersion('0.1.0')).toBe(true);
    expect(isPrereleaseVersion('0.9.9')).toBe(true);
  });

  it('treats a post-1.0 version with a pre-release tag as a pre-release', () => {
    expect(isPrereleaseVersion('1.0.0-beta.1')).toBe(true);
    expect(isPrereleaseVersion('1.2.0-rc.3')).toBe(true);
    expect(isPrereleaseVersion('2.0.0-alpha')).toBe(true);
  });

  it('treats a plain 1.0 and later as a stable release', () => {
    expect(isPrereleaseVersion('1.0.0')).toBe(false);
    expect(isPrereleaseVersion('1.2.3')).toBe(false);
    expect(isPrereleaseVersion('2.0.0')).toBe(false);
  });

  it('does not read build metadata as a pre-release tag', () => {
    expect(isPrereleaseVersion('1.0.0+build.1')).toBe(false);
  });

  it('reports a version it cannot parse as not a pre-release', () => {
    expect(isPrereleaseVersion('')).toBe(false);
    expect(isPrereleaseVersion('dev')).toBe(false);
    expect(isPrereleaseVersion('1.0')).toBe(false);
  });
});

describe('isPrereleaseBuildExpired', () => {
  it('expires a packaged pre-release once the window has passed', () => {
    expect(
      isPrereleaseBuildExpired({
        builtAt: BUILT_AT,
        now: BUILT_AT + PRERELEASE_BUILD_LIFETIME_MS + 1,
        version: '0.3.0',
        isPackaged: true,
      }),
    ).toBe(true);
  });

  it('expires a tagged 1.x pre-release too', () => {
    expect(
      isPrereleaseBuildExpired({
        builtAt: BUILT_AT,
        now: BUILT_AT + PRERELEASE_BUILD_LIFETIME_MS + 1,
        version: '1.0.0-beta.1',
        isPackaged: true,
      }),
    ).toBe(true);
  });

  it('keeps a packaged pre-release inside the window', () => {
    expect(
      isPrereleaseBuildExpired({
        builtAt: BUILT_AT,
        now: BUILT_AT + PRERELEASE_BUILD_LIFETIME_MS,
        version: '0.3.0',
        isPackaged: true,
      }),
    ).toBe(false);
  });

  it('never expires a stable release', () => {
    expect(
      isPrereleaseBuildExpired({
        builtAt: 0,
        now: BUILT_AT + 10 * 365 * DAY,
        version: '1.0.0',
        isPackaged: true,
      }),
    ).toBe(false);
  });

  it('never expires an unpackaged development run', () => {
    expect(
      isPrereleaseBuildExpired({
        builtAt: BUILT_AT,
        now: BUILT_AT + 10 * 365 * DAY,
        version: '0.0.0',
        isPackaged: false,
      }),
    ).toBe(false);
  });

  it('fails closed on a packaged pre-release with no usable timestamp', () => {
    for (const builtAt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        isPrereleaseBuildExpired({
          builtAt,
          now: BUILT_AT + 10 * 365 * DAY,
          version: '0.0.0',
          isPackaged: true,
        }),
      ).toBe(true);
    }
  });

  it('fails closed on a packaged build whose version cannot be read', () => {
    for (const version of ['', 'dev', '1.0']) {
      expect(
        isPrereleaseBuildExpired({
          builtAt: BUILT_AT,
          now: BUILT_AT + DAY,
          version,
          isPackaged: true,
        }),
      ).toBe(true);
    }
  });
});

describe('prereleaseBuildExpiredMessage', () => {
  it('names the compile date and the current build page', () => {
    const message = prereleaseBuildExpiredMessage({ builtAt: BUILT_AT, version: '0.3.0' }, t);
    expect(message).toContain('2026-01-01');
    expect(message).toContain('90-day');
    expect(message).toContain('https://macmagic.app');
  });

  it('handles a missing timestamp without throwing', () => {
    const message = prereleaseBuildExpiredMessage({ builtAt: Number.NaN, version: '0.3.0' }, t);
    expect(message).toContain('no valid build timestamp');
    expect(message).toContain('https://macmagic.app');
  });

  it('names an unreadable version when that is the reason', () => {
    const message = prereleaseBuildExpiredMessage({ builtAt: BUILT_AT, version: 'dev' }, t);
    expect(message).toContain('version could not be read');
    expect(message).toContain('https://macmagic.app');
  });

  it('asks the catalogue for exactly the keys it declares, across every branch', () => {
    const keys = new Set<string>();
    const recording: UiTranslator = (key, params) => {
      keys.add(key);
      return t(key, params);
    };
    // expired, then unreadable version, then no timestamp.
    prereleaseBuildExpiredMessage({ builtAt: BUILT_AT, version: '0.3.0' }, recording);
    prereleaseBuildExpiredMessage({ builtAt: BUILT_AT, version: 'dev' }, recording);
    prereleaseBuildExpiredMessage({ builtAt: Number.NaN, version: '0.3.0' }, recording);
    expect([...keys].sort()).toEqual([...PRERELEASE_EXPIRY_KEYS].sort());
  });
});
