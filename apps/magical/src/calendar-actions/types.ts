import type { WebContentsView } from 'electron';

export type CalendarActionOutcome = 'ok' | 'busy' | 'failed';

export type RsvpResponse = 'yes' | 'no' | 'maybe';

/**
 * What a direct RSVP write needs beyond the start time.
 *
 * The write's attendee block echoes the occurrence's own times and zone, and the caller
 * that resolved the invitation (the watcher) is the only one that has them.
 */
export interface RsvpTiming {
  endTime?: Date;
  timezone?: string;
}

export interface RsvpActionParams {
  type: 'rsvp';
  accountId: string;
  eid: string;
  response: RsvpResponse;
  startTime: Date;
}

export interface DeleteEventActionParams {
  type: 'delete';
  accountId: string;
  eid: string;
  startTime: Date;
  isTask?: boolean;
}

export interface CompleteTaskActionParams {
  type: 'completeTask';
  accountId: string;
  eid: string;
  startTime: Date;
  completed: boolean;
}

export type CalendarActionParams =
  RsvpActionParams | DeleteEventActionParams | CompleteTaskActionParams;

export interface CalendarActionDriver {
  performRsvp(
    view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    response: RsvpResponse,
    startTime: Date,
    timing?: RsvpTiming,
  ): Promise<CalendarActionOutcome>;

  deleteEvent(
    view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    startTime: Date,
    isTask?: boolean,
  ): Promise<CalendarActionOutcome>;

  setTaskCompleted(
    view: WebContentsView | undefined,
    accountId: string,
    eid: string,
    startTime: Date,
    completed: boolean,
  ): Promise<CalendarActionOutcome>;
}
