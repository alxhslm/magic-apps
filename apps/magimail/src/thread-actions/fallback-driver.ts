import type { WebContentsView } from 'electron';
import { createLogger } from '@magimail/core/logger';
import type { ThreadActionDriver, TriageAction } from './types.js';

const log = createLogger('FallbackActionDriver');

/**
 * Runs the direct write first and drives the account's view when it fails.
 *
 * The view may be `undefined` and the direct driver ignores it. Only the DOM fallback
 * needs one, and it wakes a view when the argument is absent.
 */
export class FallbackThreadActionDriver implements ThreadActionDriver {
  constructor(
    private readonly syncDriver: ThreadActionDriver,
    private readonly domDriver: ThreadActionDriver,
  ) {}

  public async perform(
    view: WebContentsView | undefined,
    accountId: string,
    threadId: string,
    action: TriageAction,
  ): Promise<boolean> {
    try {
      const ok = await this.syncDriver.perform(view, accountId, threadId, action);
      if (ok) {
        log.info(`Triage action ${action} succeeded via sync driver`);
        return true;
      }
      log.warn(`Sync driver returned false for ${action}, falling back to DOM driver`);
    } catch (err) {
      log.warn(`Sync driver threw for ${action}, falling back to DOM driver: ${err}`);
    }

    return this.domDriver.perform(view, accountId, threadId, action);
  }
}
