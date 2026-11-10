import {
  openExternalUrl as coreOpenExternalUrl,
  type AccountConfig,
  type OpenExternalUrlOptions,
} from '@magimail/core';
import { createLogger, redactUrl } from '@magimail/core/logger';
import { hasApplicationForUrl } from './native-handlers.js';
import { loadSettings } from './settings-store.js';

export { unwrapRedirectors, toNativeMeetingUrl } from '@magimail/core';

const log = createLogger('Links');

/**
 * Dispatches an external URL for an account.
 *
 * Shared click gate used by window opens and in-app navigation in Gmail.
 * Redirector wrappers are unwrapped first. Meeting URLs (Zoom, Teams)
 * are rewritten to their native schemes and fall back to the web URL when no
 * client is installed.
 */
export async function openExternalUrl(
  rawUrl: string,
  accountOrOptions?: AccountConfig | OpenExternalUrlOptions,
): Promise<void> {
  const settings = loadSettings();

  const account =
    accountOrOptions && 'id' in accountOrOptions ? accountOrOptions : accountOrOptions?.account;

  const browser =
    accountOrOptions && 'browser' in accountOrOptions && accountOrOptions.browser
      ? accountOrOptions.browser
      : settings.openLinksIn;

  try {
    await coreOpenExternalUrl(rawUrl, {
      browser,
      account,
      hasApplicationForUrl,
      rewriteUrl: settings.alwaysJoinInBrowser ? (url) => url : undefined,
    });
  } catch (err) {
    log.error('Could not open external link:', redactUrl(rawUrl), err);
  }
}
