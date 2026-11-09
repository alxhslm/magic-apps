import { shell } from 'electron';
import {
  unwrapRedirectors,
  toNativeMeetingUrl,
  openExternalUrl as openBrowserUrl,
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
  const unwrappedUrl = unwrapRedirectors(rawUrl);
  const settings = loadSettings();

  const account =
    accountOrOptions && 'id' in accountOrOptions ? accountOrOptions : accountOrOptions?.account;

  const browser =
    accountOrOptions && 'browser' in accountOrOptions && accountOrOptions.browser
      ? accountOrOptions.browser
      : settings.openLinksIn;

  const target = toNativeMeetingUrl(unwrappedUrl);

  if (target !== unwrappedUrl) {
    const scheme = target.split(':')[0];
    if (hasApplicationForUrl(target)) {
      try {
        await shell.openExternal(target);
        return;
      } catch (err) {
        log.warn(`${scheme}: refused the request, opening in the browser:`, err);
      }
    } else {
      log.info(`No application for ${scheme}:, opening in the browser`);
    }
  }

  try {
    await openBrowserUrl(unwrappedUrl, {
      browser,
      account,
    });
  } catch (err) {
    log.error('Could not open external link:', redactUrl(unwrappedUrl), err);
  }
}
