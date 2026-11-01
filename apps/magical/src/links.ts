import { shell } from 'electron';
import { unwrapRedirectors, openExternalUrl as openBrowserUrl } from '@magimail/core';
import { createLogger, redactUrl } from '@magimail/core/logger';
import { INTERNAL_ORIGINS } from './constants.js';
import { hasApplicationForUrl } from './native-handlers.js';
import { loadSettings } from './settings-store.js';
import type { CalendarAccount } from './accounts.js';

export { unwrapRedirectors } from '@magimail/core';

const log = createLogger('Links');

/**
 * Navigation policy.
 *
 * Not a feature so much as a repair: event descriptions are full of Drive
 * attachments, Maps pins and ticket links, and without this a click on one
 * replaces the calendar with a web page inside a window that has no back
 * button.
 */
export function isInternalUrl(rawUrl: string): boolean {
  try {
    const { origin } = new URL(rawUrl);
    return (INTERNAL_ORIGINS as readonly string[]).includes(origin);
  } catch {
    return false;
  }
}

/**
 * The same URL with its query dropped, for a calendar view that may resume offline.
 *
 * Google Calendar's offline service worker matches its cache on the exact URL, so any
 * query at all turns a cache hit into a failed load. Measured: `/calendar/u/0/r` is
 * served from the cache with no network, and `/calendar/u/0/r?pli=1`, which is the URL a
 * cold start leaves behind, fails. Nothing the user is looking at lives in the query;
 * Calendar carries the date and the view mode in the path.
 */
export function withoutQuery(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.search = '';
    return url.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Rewrites a recognised video conference web URL to its native desktop scheme.
 *
 * Zoom and Teams support custom schemes that join the meeting in the native client
 * directly. Google Meet has no native client and Webex is kept in the browser.
 */
export function toNativeMeetingUrl(url: string): string {
  const unwrapped = unwrapRedirectors(url);
  const zoom = /^https?:\/\/[^/]*zoom\.us\/[jw]\/(\d+)/.exec(unwrapped);
  if (zoom) {
    const pwd = /[?&]pwd=([^&]+)/.exec(unwrapped)?.[1];
    return `zoommtg://zoom.us/join?action=join&confno=${zoom[1]}${pwd ? `&pwd=${pwd}` : ''}`;
  }
  if (/^https?:\/\/teams\.(microsoft|live)\.com\//.test(unwrapped)) {
    return unwrapped.replace(/^https?:\/\//, 'msteams://');
  }
  return unwrapped;
}

/**
 * Dispatches an external URL to macOS.
 *
 * Shared click gate used by `window.open`, in-view navigation, and the Join Call button.
 * Redirector wrappers (such as Google outbound tracking links or Outlook Safelinks) are
 * unwrapped before dispatch so macOS Universal Links can resolve desktop applications
 * (e.g. Todoist, Notion, Linear, Figma). Meeting URLs (Zoom, Teams) are rewritten to their
 * native custom schemes unless `alwaysJoinInBrowser` is enabled. If a custom meeting scheme
 * has no registered client or throws, it falls back to opening the unwrapped web URL in the
 * system default browser.
 */
export async function openExternalUrl(rawUrl: string, account?: CalendarAccount): Promise<void> {
  const unwrappedUrl = unwrapRedirectors(rawUrl);
  const settings = loadSettings();
  let target = unwrappedUrl;

  if (!settings.alwaysJoinInBrowser) {
    target = toNativeMeetingUrl(target);
  }

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
    await openBrowserUrl(unwrappedUrl, { account });
  } catch (err) {
    log.error('Could not open external link:', redactUrl(unwrappedUrl), err);
  }
}
