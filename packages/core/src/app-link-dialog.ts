import { dialog } from 'electron';
import type { AppLink } from './app-links.js';

/**
 * Asks which application should open a link whose domain a desktop app owns.
 *
 * Checked by default: without a remembered answer the same question appears every time the user
 * clicks a Notion link, which is worse than either extreme. The caller stores the answer, because
 * only it knows where settings live.
 */
export async function askAboutAppLink(
  app: AppLink,
  host: string,
  browserName: string,
): Promise<{ choice: 'app' | 'browser'; remember: boolean }> {
  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: 'question',
    message: `Open this ${host} link in ${app.name}?`,
    detail: `Otherwise it opens in ${browserName}, with this account's profile.`,
    buttons: [`Open in ${app.name}`, `Open in ${browserName}`],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: `Remember this for ${host}`,
    checkboxChecked: true,
  });

  return { choice: response === 0 ? 'app' : 'browser', remember: checkboxChecked };
}
