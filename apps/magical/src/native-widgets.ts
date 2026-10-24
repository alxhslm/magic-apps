import { loadAddon } from './native-addon.js';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('Widgets');

/**
 * Ask WidgetKit to re-read the snapshot `widget-cache.ts` just wrote.
 *
 * Goes through the native addon rather than the Swift helper because
 * `WidgetCenter` (via `chronod` and BaseBoard) requires the calling process's
 * executable to match `CFBundleExecutable` (`Magical`) in the app bundle's
 * Info.plist.
 *
 * Called from `MagicalHelper`, BaseBoard logs:
 *   `Resolved bundle path <private> does not match executable <private>`
 * and `chronod` rejects the call with `ChronoCoreErrorDomain Code=10`.
 * Only the Electron main process matches `CFBundleExecutable`.
 *
 * Loads the addon on demand: the first cache write can land before the toolbar
 * has attached.
 */
export function reloadNativeWidgets(): void {
  try {
    loadAddon().reloadWidgets?.();
  } catch (error) {
    log.error('Failed to reload timelines:', error);
  }
}

/**
 * The App Group container path, creating the container on first call.
 *
 * The identifier comes from the app's own signature rather than a constant. Its
 * team prefix is fixed when the app is signed and only the certificate knows
 * it, so a build on another Apple ID that asked for a hardcoded group would be
 * asking for one it is not entitled for.
 *
 * Null when the addon is absent, or the build carries no entitlement for a
 * group at all, which is what stops the cache being written.
 */
export function appGroupContainerPath(): string | null {
  try {
    const addon = loadAddon();
    const groupId = addon.appGroupIdentifier?.();
    if (!groupId) return null;
    return addon.groupContainerPath?.(groupId) ?? null;
  } catch (error) {
    log.warn('App Group container unavailable:', error);
    return null;
  }
}
