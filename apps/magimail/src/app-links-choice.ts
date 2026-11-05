import { browserDisplayName, chooseAppForLink as askApp } from '@magimail/core';
import type { AppLink, AppLinkAnswer } from '@magimail/core';
import { loadSettings, saveSetting } from './settings-store.js';

/**
 * Asks where a link should open, and remembers the answer when asked to.
 *
 * The dialog and the meaning of its answer live in `@magimail/core`; only where settings are written
 * belongs to the app.
 */
export async function chooseAppForLink(app: AppLink): Promise<AppLinkAnswer> {
  const settings = loadSettings();

  return askApp(app, {
    browserName: browserDisplayName(settings.openLinksIn),
    onRemember: (bundleId, mode) => {
      saveSetting('appLinkChoices', { ...settings.appLinkChoices, [bundleId]: mode });
    },
  });
}
