import { reconcileOpenAtLogin, setOpenAtLogin } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { loadSettings, saveSetting } from './settings-store.js';

/**
 * Binds core's login-item handling to Magical's settings file. The rule — that
 * the OS wins on startup — lives in core; only the storage is local.
 */

export { isOpenAtLogin } from '@magimail/core';

const log = createLogger('LoginItem');

export function applyLaunchAtLogin(enabled: boolean): void {
  setOpenAtLogin(enabled);
}

/** Reconciles the stored setting against macOS. Returns the reconciled value. */
export function reconcileLaunchAtLogin(): boolean {
  const stored = loadSettings().launchAtLogin;
  const actual = reconcileOpenAtLogin(stored, (value) => saveSetting('launchAtLogin', value));

  // The user's report is "the toggle keeps turning itself off". macOS clears
  // the login item when the bundle moves or is restored onto a new Mac, and
  // adopting that quietly leaves nothing to tell them apart from a bug.
  if (stored !== actual) {
    log.warn(`Open at Login is ${actual} in macOS but was ${stored} in settings; adopting the OS`);
  }
  return actual;
}
