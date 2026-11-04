import { session } from 'electron';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('CalendarSyncState');

/**
 * Keeps the `sync.sync` request the account's own view last made.
 *
 * A write needs the client's opaque sync state, which lives in the page rather than in the
 * range payload, and a body that omits it is rejected. So this observes the page's own
 * request, and the driver reuses that envelope verbatim, swapping only the token (refreshed
 * by a read) and the change list.
 */

export interface SyncState {
  /** Absolute `sync.sync` URL, including the account's `/u/<n>/`. */
  url: string;
  /** The decoded `f.req` payload: `[<envelope>, 20000]`. */
  envelope: unknown[];
  /**
   * Everything after `f.req=…`, i.e. `cwuik=10&hl=<locale>&secid=<session token>`.
   *
   * Load-bearing rather than decorative: a request with these dropped answers `403`
   * `[["er",…,403,…,7]]` even when the sync token is current.
   */
  params: string;
  capturedAt: number;
}

const states = new Map<string, SyncState>();

function decodeUploadData(uploadData: Electron.UploadData[] | undefined): string {
  if (!uploadData?.length) return '';
  return uploadData
    .map((part) => (part.bytes ? Buffer.from(part.bytes).toString('utf8') : ''))
    .join('');
}

function decodeState(url: string, body: string, encoded: string): SyncState | undefined {
  let envelope: unknown;
  try {
    envelope = JSON.parse(decodeURIComponent(encoded.replace(/\+/g, ' ')));
  } catch {
    return undefined;
  }
  if (!Array.isArray(envelope) || !Array.isArray(envelope[0])) return undefined;

  const separator = body.indexOf('&');
  if (separator < 0) return undefined;

  return {
    url,
    envelope: envelope as unknown[],
    params: body.slice(separator + 1),
    capturedAt: Date.now(),
  };
}

/**
 * Watches a partition and records the latest `sync.sync` request its view makes,
 * and notifies when the view's own write to Calendar or Tasks completes.
 *
 * Returns a disposer. Until the account's view has posted at least one sync there is no
 * state, and a direct write is impossible — the caller falls back to driving the view.
 */
export function observeSyncState(partition: string, onMutation?: () => void): () => void {
  const ses = session.fromPartition(partition);
  const filter = { urls: ['https://calendar.google.com/calendar/u/*/sync.sync'] };
  const completionFilter = {
    urls: [
      'https://calendar.google.com/calendar/u/*/sync.sync',
      'https://tasks-pa.clients6.google.com/$rpc/google.internal.tasks.v1.TasksApiService/Sync',
    ],
  };

  if (typeof ses.webRequest?.onBeforeRequest === 'function') {
    ses.webRequest.onBeforeRequest(filter, (details, callback) => {
      try {
        if (details.method === 'POST') {
          const body = decodeUploadData(details.uploadData);
          const match = /(?:^|&)f\.req=([^&]*)/.exec(body);
          const state = match ? decodeState(details.url, body, match[1]) : undefined;
          if (state) {
            if (!states.has(partition)) {
              log.info(`Captured the sync state a direct write reuses for ${partition}`);
            }
            states.set(partition, state);
          }
        }
      } catch (err) {
        // Never break the request being observed. Logged because the write path then
        // silently has no state, and every action falls back to the view.
        log.warn('Could not read the sync.sync request the view made:', err);
      }
      callback({ cancel: false });
    });
  }

  const onCompletedListener = (details: Electron.OnCompletedListenerDetails) => {
    try {
      // Only a request the account's own view made can be the user changing something,
      // and that is what `webContentsId` says: it is absent for a request the browser
      // process started itself. Load-bearing, because the poller's Tasks *read* is a POST
      // to the same RPC through the same session and answers `2xx`; counted as a
      // mutation it made every poll trigger the next one, and the loop that ran at about
      // a poll a second is what Google answered with `429`.
      if (details.webContentsId === undefined) return;

      if (details.method === 'POST' && details.statusCode >= 200 && details.statusCode < 300) {
        log.debug(`Observed sync mutation completion on ${partition} (${details.statusCode})`);
        onMutation?.();
      }
    } catch (err) {
      log.warn('Could not handle sync mutation completion:', err);
    }
  };

  if (typeof ses.webRequest?.onCompleted === 'function' && onMutation) {
    ses.webRequest.onCompleted(completionFilter, onCompletedListener);
  }

  return () => {
    if (typeof ses.webRequest?.onBeforeRequest === 'function') {
      ses.webRequest.onBeforeRequest(filter, null);
    }
    if (typeof ses.webRequest?.onCompleted === 'function' && onMutation) {
      ses.webRequest.onCompleted(completionFilter, null);
    }
  };
}

/** The latest captured request for a partition, or undefined before the view has synced. */
export function syncStateFor(partition: string): SyncState | undefined {
  return states.get(partition);
}

/** Test seam: seed or clear a partition's state without a live view. */
export function setSyncStateForTest(partition: string, state: SyncState | undefined): void {
  if (state) states.set(partition, state);
  else states.delete(partition);
}
