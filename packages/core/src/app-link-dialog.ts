import { dialog } from 'electron';
import type { AppLink, AppLinkAnswer } from './app-links.js';

/**
 * Asks which application should open a link whose domain a desktop app owns. The checkbox writes
 * the same per-app setting that Settings shows, not a hidden remembered answer.
 */
export async function askAboutAppLink(app: AppLink, browserName: string): Promise<AppLinkAnswer> {
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question',
    message: `Open this link in ${app.name}?`,
    detail: `Otherwise it opens in ${browserName}, with this account's profile.`,
    buttons: [`Open in ${app.name}`, `Open in ${browserName}`],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: `Don't ask again for ${app.name}`,
    checkboxChecked: false,
  });

  return { choice: response === 0 ? 'app' : 'browser', dontAskAgain: checkboxChecked };
}

export interface ChooseAppOptions {
  /** The browser's name, for the dialog's second button. */
  browserName: string;
  /** Called with the answer when the user asks not to be asked again. */
  onRemember: (bundleId: string, mode: 'auto' | 'never') => void;
}

/**
 * Asks, and writes the answer back if the user asked not to be asked again. Here rather than in
 * each app, because only where settings live differs.
 */
export async function chooseAppForLink(
  app: AppLink,
  options: ChooseAppOptions,
): Promise<AppLinkAnswer> {
  const answer = await askAboutAppLink(app, options.browserName);
  if (answer.dontAskAgain) {
    options.onRemember(app.bundleId, answer.choice === 'app' ? 'auto' : 'never');
  }
  return answer;
}
