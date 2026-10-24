import { session } from 'electron';
import { createLogger } from '@magimail/core/logger';

/**
 * calendar-identity.ts
 *
 * Learns which calendars an account owns, by listening to what the account's own
 * Google Calendar view asks for.
 *
 * The range endpoints will not infer calendars from the session: an empty, null or
 * `"primary"` list returns an empty payload rather than the user's events (measured —
 * see `docs/magical/calendar-sync.md#zero-oauth-session-mechanism`). So the poller must name
 * every calendar explicitly, including the account's own, whose id is its email address.
 *
 * Nothing cookie-authenticated hands that id over cheaply: `secondarycalendars` returns
 * only the secondary ones, `sync.sync` needs an opaque sync blob the client has to have
 * built already, and `flairdata` is unrelated. The web client, however, states the full
 * list — primary first — in the body of the very first request it makes. Observing our
 * own network stack is cheaper and steadier than parsing a page, and it is not DOM
 * scraping: no rendered event data is read, and the rule that background Google data flows
 * through the poller rather than the page's DOM still holds.
 *
 * This costs one page load per account, which every account pays anyway: there are no
 * cookies without a sign-in. Afterwards the ids are persisted and the poller runs with
 * the account's view suspended.
 */

const log = createLogger('CalendarIdentity');

const EVENT_RANGE_PATTERN = /\/calendar\/u\/\d+\/sync\.(?:pre)?fetcheventrange/;

/**
 * Pulls the calendar id list out of an `f.req` body.
 *
 * Order carries no meaning and no entry is privileged: an observed request may name only
 * a subscribed calendar — `[["en-gb.uk#holiday@group.v.calendar.google.com"]]` appears in
 * capture — so callers must accumulate a union across requests rather than treat any one
 * list as the account's full set, or as primary-first.
 *
 * Returns an empty array for anything that does not parse, rather than guessing.
 */
export function parseCalendarIdsFromRequestBody(body: string): string[] {
  const match = /(?:^|&)f\.req=([^&]*)/.exec(body);
  if (!match) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(decodeURIComponent(match[1].replace(/\+/g, ' ')));
  } catch {
    return [];
  }

  // [[ [calendarId, …], [null, null, startDay, endDay], … ]]
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return [];
  const ids = payload[0][0];
  if (!Array.isArray(ids)) return [];

  return ids.filter((id): id is string => typeof id === 'string' && id.includes('@'));
}

function decodeUploadData(uploadData: Electron.UploadData[] | undefined): string {
  if (!uploadData?.length) return '';
  return uploadData
    .map((part) => (part.bytes ? Buffer.from(part.bytes).toString('utf8') : ''))
    .join('');
}

/**
 * Watches a partition and reports calendar ids as the account's view asks for them.
 *
 * Returns a disposer. The listener fires on every observed range request with whatever
 * that request named, which is often a subset; callers accumulate. Repeats are expected
 * and must be idempotent.
 */
export function observeCalendarIds(
  partition: string,
  onDiscovered: (calendarIds: string[]) => void,
): () => void {
  const ses = session.fromPartition(partition);
  const filter = { urls: ['https://calendar.google.com/calendar/u/*/sync.*'] };

  ses.webRequest.onBeforeRequest(filter, (details, callback) => {
    try {
      if (details.method === 'POST' && EVENT_RANGE_PATTERN.test(details.url)) {
        const ids = parseCalendarIdsFromRequestBody(decodeUploadData(details.uploadData));
        if (ids.length > 0) onDiscovered(ids);
      }
    } catch (err) {
      // Never let observation break the request it is observing. Logged
      // because the account's calendar set then never grows, so events from a
      // secondary calendar never appear and nothing says why.
      log.warn('Could not read the calendar ids from the request body:', err);
    }
    callback({ cancel: false });
  });

  return () => ses.webRequest.onBeforeRequest(filter, null);
}
