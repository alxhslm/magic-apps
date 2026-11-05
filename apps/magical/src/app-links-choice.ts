import { askAboutAppLink, type AppLink } from '@magimail/core';
import { saveSetting } from './settings-store.js';
import { loadSettings } from './settings-store.js';

export interface AppLinkChoice {
  choice: 'app' | 'browser';
  remember: boolean;
}

/**
 * Puts the app-or-browser question in front of the user, and remembers the answer when asked to.
 *
 * Lives in the app rather than in `@magimail/core` because persisting is the app's business: the
 * router decides where a link goes, and this decides what the user has said about it.
 */
export async function chooseAppForLink(app: AppLink, host: string): Promise<AppLinkChoice> {
  const settings = loadSettings();
  const answer = await askAboutAppLink(app, host, browserLabel(settings.openLinksIn));

  if (answer.remember) {
    saveSetting('appLinkOverrides', {
      ...settings.appLinkOverrides,
      [host]: answer.choice,
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
