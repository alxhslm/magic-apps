import { app } from 'electron';

/**
 * "Open at Login" has two homes: an app's own stored setting, and the macOS
 * login item itself, which the user can remove from System Settings › General ›
 * Login Items without ever opening the app.
 *
 * The OS is treated as the source of truth on startup. Pushing a stored value
 * down instead would silently re-add a login item the user had just removed,
 * every single launch.
 *
 * The stored value stays in the app: each one keeps its own settings file, and
 * core has no business knowing where. `reconcileOpenAtLogin` is handed the
 * stored value and a way to write it back.
 */

/** Whether macOS currently launches this app at login. */
export function isOpenAtLogin(): boolean {
  if (process.platform !== 'darwin') return false;
  return app.getLoginItemSettings().openAtLogin;
}

/** Registers or removes the macOS login item. */
export function setOpenAtLogin(enabled: boolean): void {
  if (process.platform !== 'darwin') return;

  // openAsHidden is deliberately omitted: it is a no-op on modern macOS, and
  // the window is wanted anyway — these are apps, not background agents.
  app.setLoginItemSettings({ openAtLogin: enabled });
}

/**
 * Brings a stored setting back in line with the OS, adopting the OS value when
 * the two have diverged. Returns the reconciled value, and calls `persist` only
 * when it had to change.
 *
 * Divergence is normal rather than exceptional: removing the login item in
 * System Settings, moving the bundle, or restoring the app on a new Mac all
 * clear it behind the app's back.
 */
export function reconcileOpenAtLogin(stored: boolean, persist: (value: boolean) => void): boolean {
  if (process.platform !== 'darwin') return false;

  const actual = isOpenAtLogin();
  if (stored !== actual) {
    persist(actual);
  }
  return actual;
}
