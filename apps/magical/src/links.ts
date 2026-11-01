import { shell } from 'electron';
import { createLogger, redactUrl } from '@magimail/core/logger';
import { INTERNAL_ORIGINS } from './constants.js';
import { hasApplicationForUrl } from './native-handlers.js';
import { loadSettings } from './settings-store.js';

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
 * Unwraps redirector URLs (e.g. Google's outbound `google.com/url?q=` or Outlook Safelinks)
 * to reveal the destination URL.
 */
export function unwrapRedirectors(rawUrl: string): string {
  let url = rawUrl;
  for (let hop = 0; hop < 3; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return url;
    }
    const isGoogle = parsed.hostname === 'google.com' || parsed.hostname.endsWith('.google.com');
    const isSafelinks = parsed.hostname.endsWith('safelinks.protection.outlook.com');
    const inner =
      isGoogle && parsed.pathname === '/url'
        ? parsed.searchParams.get('q') || parsed.searchParams.get('url')
        : isSafelinks
          ? parsed.searchParams.get('url')
          : null;
    if (!inner) return url;
    url = inner;
  }
  return url;
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
 * Rewrites a recognised Todoist task or project web URL to the native `todoist://` scheme.
 *
 * Supported formats:
 * - `https://app.todoist.com/app/task/<id>` -> `todoist://task?id=<id>`
 * - `https://app.todoist.com/app/project/<id>` -> `todoist://project?id=<id>`
 * - `https://todoist.com/showTask?id=<id>` -> `todoist://task?id=<id>`
 * - `https://todoist.com/showProject?id=<id>` -> `todoist://project?id=<id>`
 *
 * Outbound wrapper redirectors (such as `www.google.com/url?q=...`) are unwrapped before matching.
 * Anything else (e.g. settings, pricing, invalid IDs) is returned unchanged.
 */
export function toNativeTodoistUrl(url: string): string {
  const unwrapped = unwrapRedirectors(url);
  try {
    const parsed = new URL(unwrapped);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'todoist.com' && host !== 'app.todoist.com' && !host.endsWith('.todoist.com')) {
      return unwrapped;
    }

    const pathname = parsed.pathname;

    // Task URL: /app/task/<id>
    const taskPathMatch = pathname.match(/^\/app\/task\/([^/?#]+)/);
    if (taskPathMatch && taskPathMatch[1]) {
      return `todoist://task?id=${taskPathMatch[1]}`;
    }

    // Project URL: /app/project/<id>
    const projectPathMatch = pathname.match(/^\/app\/project\/([^/?#]+)/);
    if (projectPathMatch && projectPathMatch[1]) {
      return `todoist://project?id=${projectPathMatch[1]}`;
    }

    // Web redirectors / legacy format: /showTask?id=<id> or /app/showTask?id=<id>
    if (pathname === '/showTask' || pathname === '/app/showTask') {
      const id = parsed.searchParams.get('id');
      if (id) {
        return `todoist://task?id=${id}`;
      }
    }

    // Web redirectors / legacy format: /showProject?id=<id> or /app/showProject?id=<id>
    if (pathname === '/showProject' || pathname === '/app/showProject') {
      const id = parsed.searchParams.get('id');
      if (id) {
        return `todoist://project?id=${id}`;
      }
    }

    return unwrapped;
  } catch {
    return unwrapped;
  }
}

/**
 * Dispatches an external URL to macOS.
 *
 * Shared click gate used by `window.open`, in-view navigation, and the Join Call button.
 * Meeting URLs and Todoist URLs are unwrapped from redirectors (such as Google outbound links)
 * and rewritten to their native desktop schemes if enabled in settings. If macOS has an application
 * registered for the native scheme, it is launched; if no application is registered or the client
 * throws, it falls back to opening the web URL in the system default browser.
 */
export async function openExternalUrl(rawUrl: string): Promise<void> {
  const unwrappedUrl = unwrapRedirectors(rawUrl);
  const settings = loadSettings();
  let native = unwrappedUrl;

  if (!settings.alwaysJoinInBrowser) {
    native = toNativeMeetingUrl(native);
  }
  if (settings.openTodoistInDesktopApp && native === unwrappedUrl) {
    native = toNativeTodoistUrl(native);
  }

  if (native !== unwrappedUrl) {
    const scheme = native.split(':')[0];
    if (hasApplicationForUrl(native)) {
      try {
        await shell.openExternal(native);
        return;
      } catch (err) {
        log.warn(`${scheme}: refused the request, opening in the browser:`, err);
      }
    } else {
      log.info(`No application for ${scheme}:, opening in the browser`);
    }
  }

  try {
    await shell.openExternal(unwrappedUrl);
  } catch (err) {
    log.error('Could not open external link:', redactUrl(unwrappedUrl), err);
  }
}
