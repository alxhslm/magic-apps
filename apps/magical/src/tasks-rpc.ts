/**
 * The transport Google Tasks' internal web sync shares between its read and its write.
 *
 * Reading and writing are one RPC with one authentication and differ only in the body, so
 * the URL, the signed header and the cookie handling are spelled once: `tasks-poller.ts`
 * reads through it and the direct action write writes through it. The API key is Google's
 * own, read from the page; see `docs/magical/google-tasks.md`, "Wire protocol and
 * authentication".
 */
import { session } from 'electron';
import crypto from 'node:crypto';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('TasksRpc');

export const TASKS_SYNC_URL =
  'https://tasks-pa.clients6.google.com/$rpc/google.internal.tasks.v1.TasksApiService/Sync';

export const CALENDAR_ORIGIN = 'https://calendar.google.com';

/**
 * `SAPISIDHASH <timestamp>_<sha1>_u` over `<gaiaId> <timestamp> <sapisid> <origin>`.
 *
 * Measured, not derived: the same RPC rejects a hash built from the older
 * `<timestamp> <sapisid> <origin>` preimage, and without the Gaia ID in front it answers
 * `401` however well formed the rest of the request is.
 */
export function sapisidHash(gaiaId: string, sapisid: string, timestamp: number): string {
  const digest = crypto
    .createHash('sha1')
    .update(`${gaiaId} ${timestamp} ${sapisid} ${CALENDAR_ORIGIN}`)
    .digest('hex');
  return `SAPISIDHASH ${timestamp}_${digest}_u`;
}

export interface TasksSyncAuth {
  partition: string;
  gaiaId: string;
  accountIndex?: number;
  /** Google's public browser key, read from the page. Omitted until the page has been read. */
  apiKey?: string;
}

/** The headers every Tasks Sync request carries, signed over the active session. */
export function tasksSyncHeaders(
  auth: TasksSyncAuth,
  sapisid: string,
  timestamp: number,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json+protobuf',
    Authorization: sapisidHash(auth.gaiaId, sapisid, timestamp),
    'X-User-Agent': 'grpc-web-javascript/0.1',
    'X-Goog-AuthUser': String(auth.accountIndex ?? 0),
    // Google checks this against the origin the SAPISIDHASH is signed over, and rejects
    // the request with 401 when it is absent. A browser sets it itself on a cross-origin
    // request; Electron's `session.fetch` runs outside any document and sets nothing.
    Origin: CALENDAR_ORIGIN,
  };
  // Read from the page, so a build that has not yet learned it omits the header rather
  // than sending an empty key.
  if (auth.apiKey) headers['X-Goog-Api-Key'] = auth.apiKey;
  return headers;
}

/** The partition's `SAPISID` cookie, or null when the session has expired. */
export async function readSapisidCookie(partition: string): Promise<string | null> {
  try {
    const cookies = await session.fromPartition(partition).cookies.get({ name: 'SAPISID' });
    return cookies[0]?.value ?? null;
  } catch (err) {
    log.warn(`failed to read the SAPISID cookie in ${partition}:`, err);
    return null;
  }
}

export interface TasksSyncRequest {
  partition: string;
  headers: Record<string, string>;
  body: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * One POST to the Sync RPC.
 *
 * `credentials: 'include'` is load-bearing: without it the partition's cookies are left
 * off a cross-host request and Google answers `401`, however well formed the SAPISIDHASH
 * is.
 */
export async function postTasksSync(request: TasksSyncRequest): Promise<Response> {
  const doFetch =
    request.fetchImpl ??
    ((url: string, init: RequestInit) => session.fromPartition(request.partition).fetch(url, init));

  return doFetch(TASKS_SYNC_URL, {
    method: 'POST',
    headers: request.headers,
    cache: 'no-store',
    credentials: 'include',
    body: request.body,
  });
}

/**
 * The Sync read body.
 *
 * A positional proto: seven collection slots asking for the account's lists, tasks and
 * recurrence definitions, keyed by the Gaia ID. It is the same body the page's own client
 * sends, and the only request shape this RPC accepts for a read.
 */
export function tasksReadBody(gaiaId: string): unknown[] {
  return [
    [
      [
        [null, []],
        [[]],
        [null, null, []],
        [null, null, null, []],
        [null, null, null, null, null, []],
        [null, null, null, null, [null, null, [null, 1, null, 1, 1, 1]]],
        [null, null, null, null, [null, null, [1, null, null, 1, 1, 1]]],
      ],
      [],
    ],
    null,
    [null, [gaiaId]],
  ];
}
