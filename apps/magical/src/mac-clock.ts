/**
 * mac-clock.ts
 *
 * Reads the Mac's 12/24-hour switch. Electron's only route to it is the `NSUserDefaults`
 * key macOS writes, and the key is absent until the user first changes the switch.
 *
 * The stored type is not fixed: a boolean is the common shape, an integer appears on some
 * versions, and a string on others. The reads are attempted in the order that tells an
 * absent key apart from a false one, because reading a missing key as `false` would pin a
 * 24-hour region to a 12-hour clock — the same bug in the other direction.
 */
import { systemPreferences } from 'electron';

const KEY = 'AppleICUForce24HourTime';

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
 * The Mac's forced 24-hour setting, or `undefined` when it has never been set.
 *
 * A missing key reads as an empty string, which `parseForced24Hour` rejects. A key stored
 * as another type makes the typed read throw, and the next type is tried.
 */
export function readMacForced24Hour(): boolean | undefined {
  try {
    return parseForced24Hour(systemPreferences.getUserDefault(KEY, 'string'));
  } catch {
    // Stored as an integer or a boolean; fall through to those reads.
  }

  for (const type of ['integer', 'boolean'] as const) {
    try {
      return parseForced24Hour(systemPreferences.getUserDefault(KEY, type));
    } catch {
      // Try the next type.
    }
  }

  return undefined;
}
