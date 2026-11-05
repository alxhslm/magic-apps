/**
 * mac-clock.ts
 *
 * Reads the Mac's 12/24-hour switch. Electron's only route to it is `NSUserDefaults`, and
 * macOS writes two keys rather than one: turning 24-hour on sets `AppleICUForce24HourTime`,
 * while turning it off sets `AppleICUForce12HourTime`. A Mac that prefers 12-hour on a
 * 24-hour region therefore has the first key absent and the second set, so reading only the
 * 24-hour key falls through to a 24-hour region.
 *
 * The stored type is not fixed: a boolean is the common shape, an integer appears on some
 * versions, and a string on others. The reads are attempted in the order that tells an
 * absent key apart from a false one, because reading a missing key as `false` would pin a
 * 24-hour region to a 12-hour clock — the same bug in the other direction.
 */
import { systemPreferences } from 'electron';

const FORCE_24_HOUR_KEY = 'AppleICUForce24HourTime';
const FORCE_12_HOUR_KEY = 'AppleICUForce12HourTime';
const LOCALE_KEY = 'AppleLocale';

/** Interprets whatever `getUserDefault` returned, or `undefined` when it says nothing. */
export function parseForced24Hour(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === '1' || text === 'true' || text === 'yes') return true;
    if (text === '0' || text === 'false' || text === 'no') return false;
  }
  return undefined;
}

/**
 * One key's value, or `undefined` when it is absent or unreadable.
 *
 * A missing key reads as an empty string, which `parseForced24Hour` rejects. A key stored
 * as another type makes the typed read throw, and the next type is tried.
 */
function readFlag(key: string): boolean | undefined {
  try {
    return parseForced24Hour(systemPreferences.getUserDefault(key, 'string'));
  } catch {
    // Stored as an integer or a boolean; fall through to those reads.
  }

  for (const type of ['integer', 'boolean'] as const) {
    try {
      return parseForced24Hour(systemPreferences.getUserDefault(key, type));
    } catch {
      // Try the next type.
    }
  }

  return undefined;
}

/**
 * The Mac's forced setting: `true` for 24-hour, `false` for 12-hour, `undefined` when
 * neither key forces one and the locale decides. 24-hour wins when both are set, matching
 * Foundation.
 */
export function readMacForced24Hour(): boolean | undefined {
  if (readFlag(FORCE_24_HOUR_KEY) === true) return true;
  if (readFlag(FORCE_12_HOUR_KEY) === true) return false;
  return undefined;
}

/**
 * The Mac's region as an `Intl` tag, or `undefined` when it cannot be read.
 *
 * `AppleLocale` looks like `en_GB` and can carry keywords after `@`; `Intl` wants
 * `en-GB`, so the underscore is replaced and the keywords dropped. This is the live value,
 * which `app.getLocale()` is not: Chromium resolves its locale at launch.
 */
export function readMacLocale(): string | undefined {
  try {
    const raw = systemPreferences.getUserDefault(LOCALE_KEY, 'string');
    if (typeof raw !== 'string') return undefined;

    const base = raw.split('@')[0]?.trim();
    if (!base) return undefined;
    return base.replace(/_/g, '-');
  } catch {
    return undefined;
  }
}
