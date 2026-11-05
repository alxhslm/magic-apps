import { askAboutAppLink, modeFromAnswer, type AppLink, type AppLinkAnswer } from '@magimail/core';
import { loadSettings, saveSetting } from './settings-store.js';

/**
 * Puts the app-or-browser question in front of the user, and writes the answer back when asked to.
 *
 * The persisted answer is the same per-app setting Settings shows, so ticking "don't ask again" and
 * then opening Settings tells the same story rather than leaving a hidden preference behind.
 */
export async function chooseAppForLink(app: AppLink): Promise<AppLinkAnswer> {
  const settings = loadSettings();
  const answer = await askAboutAppLink(app, browserLabel(settings.openLinksIn));

  if (answer.dontAskAgain) {
    saveSetting('appLinkChoices', {
      ...settings.appLinkChoices,
      [app.bundleId]: modeFromAnswer(answer),
    });
  }

  return answer;
}

/** The browser's name as the dialog should say it. */
function browserLabel(openLinksIn: string): string {
  switch (openLinksIn) {
    case 'chrome':
      return 'Google Chrome';
    case 'brave':
      return 'Brave';
    case 'edge':
      return 'Microsoft Edge';
    case 'safari':
      return 'Safari';
    default:
      return 'your browser';
  }
}
