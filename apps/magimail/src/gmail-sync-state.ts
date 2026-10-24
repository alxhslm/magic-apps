import type { Session } from 'electron';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('GmailSyncState');

/**
 * The headers Gmail's own `/sync/` traffic carries, replayed so a triage write can be
 * posted from the main process.
 *
 * The write needs `X-Framework-Xsrf-Token`, which rides in the request headers rather
 * than the body, so the capture watches `onBeforeSendHeaders`; `onBeforeRequest` never
 * sees them. Keyed by partition rather than by the `Session` object, so the capture
 * outlives the page that produced it.
 */
export interface GmailSyncState {
  /** The account slot Gmail's own request used, read from `/sync/u/<n>/`. */
  accountIndex: string;
  /** The request headers Gmail's own `/sync/` request carried. */
  headers: Record<string, string>;
  capturedAt: number;
}

/**
 * Headers the network stack sets itself. A replay is either rejected with one of these
 * present or overwrites the value the stack derived, so they are left off.
 */
const DROP_HEADERS = new Set([
  'cookie',
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'proxy-connection',
]);

/** Request headers safe to replay, dropping those the stack owns. */
export function pickReplayHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (!DROP_HEADERS.has(name.toLowerCase())) picked[name] = value;
  }
  return picked;
}

/** The `u/<n>` slot in a `/sync/` URL, or null when the URL is not one. */
export function accountIndexFromUrl(url: string): string | null {
  const match = /\/sync\/u\/(\d+)\//.exec(url ?? '');
  return match ? match[1] : null;
}

/** The header names a capture holds, sorted. The token is a credential, so it is never logged. */
export function headerNames(headers: Record<string, string>): string {
  return Object.keys(headers).sort().join(',');
}

const states = new Map<string, GmailSyncState>();
const observed = new WeakSet<Session>();

/**
 * Records the headers a partition's session sends to `/sync/`.
 *
 * Returns a disposer. Until the page makes a `/sync/` request there is no capture, the
 * sync driver returns false, and the DOM fallback drives the action.
 */
export function observeGmailSyncState(ses: Session, partition: string): () => void {
  if (!ses || observed.has(ses)) return () => {};
  observed.add(ses);

  const filter = { urls: ['https://mail.google.com/*'] };
  const listener = (
    details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (response: Electron.BeforeSendResponse) => void,
  ) => {
    try {
      if (details.url.includes('/sync/')) {
        const headers = pickReplayHeaders(details.requestHeaders);
        if (Object.keys(headers).length > 0) {
          const previous = states.get(partition);
          const previousToken = previous?.headers['X-Framework-Xsrf-Token'];
          const token = headers['X-Framework-Xsrf-Token'];
          if (previousToken && token && previousToken !== token) {
            log.info(`Gmail rotated the /sync/ XSRF token for ${partition}`);
          }
          const accountIndex = accountIndexFromUrl(details.url) ?? previous?.accountIndex ?? '0';
          if (!previous) {
            log.info(
              `Captured /sync/ request headers for a direct write on ${partition}: [${headerNames(headers)}]`,
            );
          }
          states.set(partition, { accountIndex, headers, capturedAt: Date.now() });
        }
      }
    } catch (err) {
      // Never break the request being observed. The write path then logs that it has
      // no capture and falls back to the page.
      log.warn('Could not read the /sync/ request headers the page sent:', err);
    }
    callback({ requestHeaders: details.requestHeaders });
  };

  ses.webRequest.onBeforeSendHeaders(filter, listener);
  return () => ses.webRequest.onBeforeSendHeaders(filter, null);
}

/** The latest captured `/sync/` headers for a partition, or undefined before one. */
export function gmailSyncStateFor(partition: string): GmailSyncState | undefined {
  return states.get(partition);
}

/** Test seam: seed or clear a partition's capture without a live page. */
export function setGmailSyncStateForTest(
  partition: string,
  state: GmailSyncState | undefined,
): void {
  if (state) states.set(partition, state);
  else states.delete(partition);
}
