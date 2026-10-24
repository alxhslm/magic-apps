import { createLogger } from '@magimail/core/logger';
import { postTasksSync, readSapisidCookie, tasksReadBody, tasksSyncHeaders } from './tasks-rpc.js';
import {
  parseTasksSyncResponse,
  TasksDecodeError,
  TasksSessionExpiredError,
  TasksNetworkError,
  TasksRefusedError,
  type TasksSyncResult,
} from './tasks-decoder.js';

const log = createLogger('TasksPoller');

/** First pause after a refusal; each refusal after it doubles the pause. */
const REFUSAL_BASE_MS = 15 * 60 * 1000;
/** A refusal that keeps happening is retried four times a day rather than on every poll. */
const REFUSAL_CAP_MS = 6 * 60 * 60 * 1000;

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

  /** Until this time a refusal is reused rather than asked about again. */
  private refusedUntil = 0;
  private refusedStatus: number | null = null;
  private consecutiveRefusals = 0;

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
    if (now < this.refusedUntil) {
      log.debug(
        `${this.id}: still refusing tasks sync; next attempt in ${this.refusedUntil - now}ms`,
      );
      throw new TasksRefusedError(this.refusedStatus ?? 403, this.refusedUntil - now);
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
      this.refusedUntil = Date.now() + retryAfterMs;
      this.refusedStatus = response.status;
      // Said once per episode. The polls inside the pause are skipped before the
      // request, so they cannot repeat it; the next attempt says so again only if it
      // is refused too.
      log.warn(
        `${this.id}: Google refused tasks sync with HTTP ${response.status}; next attempt in ${Math.round(retryAfterMs / 60000)} min`,
      );
      throw new TasksRefusedError(response.status, retryAfterMs);
    }

    if (!response.ok) {
      throw new TasksDecodeError(`Tasks Sync returned HTTP ${response.status}`);
    }

    const text = await response.text();
    const result = parseTasksSyncResponse(text);
    this.lastSuccessAt = new Date();
    this.refusedUntil = 0;
    this.refusedStatus = null;
    this.consecutiveRefusals = 0;
    log.info(
      `${this.id}: ${result.tasks.size} task(s), ${result.occurrences.length} recurring occurrence(s)`,
    );
    return result;
  }
}
