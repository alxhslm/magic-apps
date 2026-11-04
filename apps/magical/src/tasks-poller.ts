import { createLogger } from '@magimail/core/logger';
import { postTasksSync, readSapisidCookie, tasksReadBody, tasksSyncHeaders } from './tasks-rpc.js';
import {
  parseTasksSyncResponse,
  TasksDecodeError,
  TasksSessionExpiredError,
  TasksNetworkError,
  TasksRateLimitedError,
  TasksRefusedError,
  type TasksSyncResult,
} from './tasks-decoder.js';

const log = createLogger('TasksPoller');

/** First pause after a refusal; each refusal after it doubles the pause. */
const REFUSAL_BASE_MS = 15 * 60 * 1000;
/** A refusal that keeps happening is retried four times a day rather than on every poll. */
const REFUSAL_CAP_MS = 6 * 60 * 60 * 1000;

/** First pause after a 429; each one after it doubles the pause. */
const RATE_LIMIT_BASE_MS = 60 * 1000;
/** A rate limit that keeps happening is retried no faster than the ordinary poll cadence. */
const RATE_LIMIT_CAP_MS = 15 * 60 * 1000;

/**
 * A status Google answers with when it will not serve Tasks to this account at all.
 *
 * 401 is handled before this, as an expired session. 400, 403 and 404 are permanent
 * for as long as the account is in that state: usually Tasks has never been granted, or
 * the account is one Google will not serve the internal endpoint for.
 */
function isRefusal(status: number): boolean {
  return status === 400 || status === 403 || status === 404;
}

/**
 * The pause a `Retry-After` header asks for, or null when it is absent or unreadable.
 *
 * Google sends whole seconds on this RPC; the HTTP-date form is valid by the spec, so both
 * are read rather than assuming the shape. The caller caps the answer either way.
 */
function retryAfterFrom(response: Response): number | null {
  let raw: string | null = null;
  try {
    raw = response.headers?.get('retry-after') ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const instant = Date.parse(raw);
  if (Number.isNaN(instant)) return null;
  return Math.max(0, instant - Date.now());
}

export interface TasksPollerOptions {
  id: string;
  accountId: string;
  partition: string;
  accountIndex?: number;
  gaiaId?: string;
  /**
   * Google's public browser API key, read from the Calendar page rather than committed.
   *
   * It is the key Google's own web client sends on this RPC. It is not a Magic Apps
   * credential: it ships to every browser that loads Calendar, it is referrer-restricted,
   * and on its own it reaches no user data -- the request still needs the partition's
   * session cookies and a SAPISIDHASH signed over the active session. Keeping a copy in
   * source made a public, credential-shaped string look like a secret in a repository
   * about to be published, so it is read from `WIZ_global_data` at runtime instead; see
   * `docs/magical/google-tasks.md`.
   */
  apiKey?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  getSapisidImpl?: () => Promise<string | null>;
}

export class TasksPoller {
  public readonly id: string;
  public readonly accountId: string;
  private readonly partition: string;
  private readonly accountIndex: number;
  private gaiaId?: string;
  private apiKey?: string;
  private readonly fetchImpl?: TasksPollerOptions['fetchImpl'];
  private readonly getSapisidImpl?: TasksPollerOptions['getSapisidImpl'];

  private lastSuccessAt: Date | null = null;
  /** The last read reported, so a poll answering the same thing again is logged once. */
  private lastSummary: string | null = null;

  /**
   * Until this time the poller does not ask again, and `pausedWith` says why.
   *
   * One pause covers both a refusal and a rate limit: they differ in the delay they earn
   * and the error they raise, not in whether asking again this soon is worth anything.
   */
  private pausedUntil = 0;
  private pausedWith: TasksRefusedError | TasksRateLimitedError | null = null;
  private consecutiveRefusals = 0;
  private consecutiveRateLimits = 0;

  constructor(options: TasksPollerOptions) {
    this.id = options.id;
    this.accountId = options.accountId;
    this.partition = options.partition;
    this.accountIndex = options.accountIndex ?? 0;
    this.gaiaId = options.gaiaId;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl;
    this.getSapisidImpl = options.getSapisidImpl;
  }

  public get lastSuccessfulReadAt(): Date | null {
    return this.lastSuccessAt;
  }

  public get currentGaiaId(): string | undefined {
    return this.gaiaId;
  }

  public updateGaiaId(gaiaId: string): void {
    this.gaiaId = gaiaId;
  }

  public get currentApiKey(): string | undefined {
    return this.apiKey;
  }

  public updateApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  private async getSapisid(): Promise<string | null> {
    if (this.getSapisidImpl) return this.getSapisidImpl();
    return readSapisidCookie(this.partition);
  }

  /**
   * Fetches the user's tasks and their completion state from Google Tasks Sync API.
   */
  public async fetchTasks(): Promise<TasksSyncResult> {
    if (!this.gaiaId) {
      log.debug(`${this.id}: gaiaId not yet learned; skipping tasks sync`);
      return { tasks: new Map(), tasksById: new Map(), occurrences: [] };
    }

    const now = Date.now();
    if (this.pausedWith && now < this.pausedUntil) {
      log.debug(
        `${this.id}: ${this.pausedWith.message}; next attempt in ${this.pausedUntil - now}ms`,
      );
      throw this.pausedWith;
    }

    const sapisid = await this.getSapisid();
    if (!sapisid) {
      log.warn(`${this.id}: no SAPISID cookie in partition; tasks session expired`);
      throw new TasksSessionExpiredError();
    }

    const headers = tasksSyncHeaders(
      {
        partition: this.partition,
        gaiaId: this.gaiaId,
        accountIndex: this.accountIndex,
        apiKey: this.apiKey,
      },
      sapisid,
      Math.floor(Date.now() / 1000),
    );
    const body = JSON.stringify(tasksReadBody(this.gaiaId));

    let response: Response;
    try {
      response = await postTasksSync({
        partition: this.partition,
        headers,
        body,
        fetchImpl: this.fetchImpl,
      });
    } catch (err) {
      throw new TasksNetworkError(`Tasks Sync could not reach Google: ${String(err)}`);
    }

    if (response.status === 401) {
      throw new TasksSessionExpiredError();
    }

    if (isRefusal(response.status)) {
      this.consecutiveRefusals += 1;
      const retryAfterMs = Math.min(
        REFUSAL_BASE_MS * 2 ** (this.consecutiveRefusals - 1),
        REFUSAL_CAP_MS,
      );
      const refusal = new TasksRefusedError(response.status, retryAfterMs);
      this.pausedUntil = Date.now() + retryAfterMs;
      this.pausedWith = refusal;
      // Said once per episode. The polls inside the pause are skipped before the
      // request, so they cannot repeat it; the next attempt says so again only if it
      // is refused too.
      log.warn(
        `${this.id}: Google refused tasks sync with HTTP ${response.status}; next attempt in ${Math.round(retryAfterMs / 60000)} min`,
      );
      throw refusal;
    }

    // A rate limit is the one failure where asking again is what makes it worse, so it
    // is paused like a refusal rather than retried on the next poll. Left unpaused, a
    // burst of polls keeps the account limited for as long as the burst lasts.
    if (response.status === 429) {
      this.consecutiveRateLimits += 1;
      const pauseMs = Math.min(
        retryAfterFrom(response) ?? RATE_LIMIT_BASE_MS * 2 ** (this.consecutiveRateLimits - 1),
        RATE_LIMIT_CAP_MS,
      );
      const limited = new TasksRateLimitedError(pauseMs);
      this.pausedUntil = Date.now() + pauseMs;
      this.pausedWith = limited;
      log.warn(
        `${this.id}: Google rate-limited tasks sync with HTTP 429; next attempt in ${Math.round(pauseMs / 1000)} s`,
      );
      throw limited;
    }

    if (!response.ok) {
      throw new TasksDecodeError(`Tasks Sync returned HTTP ${response.status}`);
    }

    const text = await response.text();
    const result = parseTasksSyncResponse(text);
    this.lastSuccessAt = new Date();
    this.pausedUntil = 0;
    this.pausedWith = null;
    this.consecutiveRefusals = 0;
    this.consecutiveRateLimits = 0;

    // A read that answers the same thing again is not news. An account that holds no
    // tasks would otherwise write the same line every five minutes, which is how a
    // healthy poller came to read as a dead one.
    const summary = `${result.tasks.size} task(s), ${result.occurrences.length} recurring occurrence(s)`;
    if (summary === this.lastSummary) {
      log.debug(`${this.id}: ${summary}`);
    } else {
      this.lastSummary = summary;
      log.info(`${this.id}: ${summary}`);
    }
    return result;
  }
}
