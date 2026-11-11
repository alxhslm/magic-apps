import {
  unwrapRedirectors,
  toNativeMeetingUrl,
  openExternalUrl as openBrowserUrl,
} from '@magimail/core';
import { createLogger, redactUrl } from '@magimail/core/logger';
import { INTERNAL_ORIGINS } from './constants.js';
import { hasApplicationForUrl } from './native-handlers.js';
import { loadSettings } from './settings-store.js';
import type { CalendarAccount } from './accounts.js';

export { unwrapRedirectors, toNativeMeetingUrl } from '@magimail/core';

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
 * Rewrites a Todoist task or project link to its desktop scheme.
 *
 * Todoist's site does not hand off to the desktop app, and calendar events carry task links,
 * so this is the one app Magical opens itself. The id is the same in both forms.
 */
export function toTodoistAppUrl(url: string): string {
  const unwrapped = unwrapRedirectors(url);
  const match = /^https?:\/\/(?:app\.)?todoist\.com\/app\/(task|project)\/([A-Za-z0-9]+)/.exec(
    unwrapped,
  );
  return match ? `todoist://${match[1]}?id=${match[2]}` : unwrapped;
}

/**
 * Dispatches an external URL for an account.
 *
 * Shared click gate used by `window.open`, in-view navigation and the Join Call button.
 * Redirector wrappers are unwrapped first, so the router sees the destination. Meeting URLs
 * (Zoom, Teams) are rewritten to their native schemes unless `alwaysJoinInBrowser` is on, and
 * fall back to the web URL when no client is installed.
 */
export async function openExternalUrl(rawUrl: string, account?: CalendarAccount): Promise<void> {
  const settings = loadSettings();

  try {
    await openBrowserUrl(rawUrl, {
      browser: settings.openLinksIn,
      account,
      hasApplicationForUrl,
      rewriteUrl: (url) => {
        let target = url;
        if (!settings.alwaysJoinInBrowser) {
          target = toNativeMeetingUrl(target);
        }
        if (target === url && settings.openTodoistLinksInApp) {
          target = toTodoistAppUrl(target);
        }
        return target;
      },
    });
  } catch (err) {
    log.error('Could not open external link:', redactUrl(rawUrl), err);
  }
}
