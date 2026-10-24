import type { WebContentsView } from 'electron';
import { createLogger } from '@magimail/core/logger';
import type {
  CalendarActionDriver,
  CalendarActionOutcome,
  RsvpResponse,
  RsvpTiming,
} from './types.js';

const log = createLogger('FallbackCalendarActionDriver');

/**
 * Executes calendar actions (RSVP, delete, task completion) preferring the internal
 * sync/Tasks API driver (headless, fast, zero viewport navigation), falling back
 * gracefully to the DOM driver if the sync driver fails or encounters an unhandled error.
 */
export class FallbackCalendarActionDriver implements CalendarActionDriver {
  constructor(
    private readonly syncDriver: CalendarActionDriver,
    private readonly domDriver: CalendarActionDriver,
  ) {}

  public async performRsvp(
    view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    response: RsvpResponse,
    startTime: Date,
    timing?: RsvpTiming,
  ): Promise<CalendarActionOutcome> {
    try {
      const outcome = await this.syncDriver.performRsvp(
        view,
        accountId,
        eid,
        response,
        startTime,
        timing,
      );
      if (outcome === 'ok') {
        log.info(`RSVP ${response} succeeded via sync driver`);
        return 'ok';
      }
      if (outcome === 'busy') {
        return 'busy';
      }
      log.warn(`Sync driver returned failed for RSVP ${response}, falling back to DOM driver`);
    } catch (err) {
      log.warn(`Sync driver threw for RSVP ${response}, falling back to DOM driver: ${err}`);
    }

    return this.domDriver.performRsvp(view, accountId, eid, response, startTime, timing);
  }

  public async deleteEvent(
    view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    startTime: Date,
    isTask = false,
  ): Promise<CalendarActionOutcome> {
    try {
      const outcome = await this.syncDriver.deleteEvent(view, accountId, eid, startTime, isTask);
      if (outcome === 'ok') {
        log.info(`Delete event succeeded via sync driver`);
        return 'ok';
      }
      if (outcome === 'busy') {
        return 'busy';
      }
      log.warn(`Sync driver returned failed for delete event, falling back to DOM driver`);
    } catch (err) {
      log.warn(`Sync driver threw for delete event, falling back to DOM driver: ${err}`);
    }

    return this.domDriver.deleteEvent(view, accountId, eid, startTime, isTask);
  }

  public async setTaskCompleted(
    view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    startTime: Date,
    completed: boolean,
  ): Promise<CalendarActionOutcome> {
    try {
      const outcome = await this.syncDriver.setTaskCompleted(
        view,
        accountId,
        eid,
        startTime,
        completed,
      );
      if (outcome === 'ok') {
        log.info(`Task completion succeeded via sync driver`);
        return 'ok';
      }
      if (outcome === 'busy') {
        return 'busy';
      }
      log.warn(`Sync driver returned failed for completeTask, falling back to DOM driver`);
    } catch (err) {
      log.warn(`Sync driver threw for completeTask, falling back to DOM driver: ${err}`);
    }

    return this.domDriver.setTaskCompleted(view, accountId, eid, startTime, completed);
  }
}
