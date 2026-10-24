import { app, dialog } from 'electron';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDemoMode, scheduleRemoval, setOpenAtLogin } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';
import { sendToHelper } from './swift-helper.js';
import { appGroupContainerPath } from './native-widgets.js';
import { uiString } from './strings.js';

/**
 * "Remove All App Data and Quit…" -- the app menu item that leaves nothing of the
 * install behind.
 *
 * macOS runs no code when a bundle is deleted and never clears an app's
 * `~/Library` files, so the user who drags Magimail to the Bin leaves Google
 * sessions, caches, the login item and its notifications on disk forever. This is
 * the only moment that cleanup can run: from inside the app, before it is gone.
 *
 * The deletion itself is not done here. `scheduleRemoval` hands it to a detached
 * shell that waits for this process to exit, because Chromium flushes `Local
 * State` and its singleton files *during* shutdown and an in-process delete races
 * the browser still writing to userData. See `packages/core/src/app-removal.ts`
 * and `docs/shared/sessions-and-security.md`.
 */

const log = createLogger('Removal');

const APP_NAME = 'Magimail';
const BUNDLE_ID = 'com.alexhaslam.magimail';

/** Set to `1` to offer the item on a run the gate below would otherwise refuse. */
export const REMOVE_ALL_ENV_VAR = 'MAGIMAIL_REMOVE_ALL';

/** The `dialog.showMessageBox` buttons, by index. Cancel is both default and cancel. */
const CANCEL_BUTTON = 0;
const REMOVE_BUTTON = 1;

/**
 * Whether this launch may offer "Remove All App Data and Quit…".
 *
 * Only a normal installed launch, because the item removes *the install's* files.
 * A `--profile`, `--user-data-dir`, `<APP>_USER_DATA_DIR` or demo run keeps its
 * own userData, and a menu that quietly deleted the default install's accounts
 * from such a run would be deleting somebody else's data. A demo is refused even
 * though its profile differs from the default, since the App Group container it
 * is kept out of is keyed to the bundle rather than to the profile.
 *
 * `MAGIMAIL_REMOVE_ALL=1` bypasses the gate so an end-to-end test can drive the
 * flow from an unpackaged build.
 */
export function canRemoveAllAppData(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[REMOVE_ALL_ENV_VAR] === '1') return true;
  if (!app.isPackaged) return false;
  if (isDemoMode()) return false;

  const defaultUserData = path.join(app.getPath('appData'), app.name);
  return path.resolve(app.getPath('userData')) === path.resolve(defaultUserData);
}

/**
 * Confirms, then removes everything the install wrote and quits.
 *
 * The login item and the notifications are cleared from here rather than left to
 * the shell: neither is a file under userData, and a login item that outlives the
 * bundle would keep launching something that is no longer there.
 */
export async function removeAllAppDataAndQuit(): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: uiString('dialog.removeAllData.title'),
    message: uiString('dialog.removeAllData.message'),
    detail: uiString('dialog.removeAllData.detail', { app: APP_NAME }),
    buttons: [uiString('dialog.cancel'), uiString('dialog.removeAllData.confirm')],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
  });
  if (response !== REMOVE_BUTTON) return;

  log.warn('Removing all app data and quitting');

  // Every step before the quit is guarded on its own: the user has confirmed the
  // removal, and one of them throwing must not leave the app open having done nothing.
  try {
    setOpenAtLogin(false);
  } catch (err) {
    // A login item that outlives the bundle keeps launching something that is gone,
    // but it is recoverable from System Settings.
    log.error('Could not clear the login item before removal:', err);
  }

  try {
    await sendToHelper('notify.clearAll');
  } catch (err) {
    // An unanswered helper leaves only the delivered notifications behind.
    log.error('Could not clear notifications before removal:', err);
  }

  try {
    scheduleRemoval({
      appName: APP_NAME,
      bundleId: BUNDLE_ID,
      home: os.homedir(),
      userDataPath: app.getPath('userData'),
      logsPath: app.getPath('logs'),
      // A demo run must never reach the real App Group container, and only Magimail's
      // helper refuses demo on its own. Guard here so both apps behave alike.
      groupContainerPath: isDemoMode() ? null : appGroupContainerPath(),
    });
  } catch (err) {
    log.error('Could not schedule the removal:', err);
  }

  app.quit();
}
