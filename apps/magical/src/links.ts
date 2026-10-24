import { INTERNAL_ORIGINS } from './constants.js';

/**
 * Navigation policy.
 *
 * Not a feature so much as a repair: event descriptions are full of Drive
 * attachments, Maps pins and ticket links, and without this a click on one
 * replaces the calendar with a web page inside a window that has no back
 * button. Parsing meeting URLs into `zoommtg://` and `msteams://` is a separate
 * job and belongs to Phase 2.
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
