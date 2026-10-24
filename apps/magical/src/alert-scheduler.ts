import { createLogger } from '@magimail/core/logger';
import { RESPONSE_DECLINED, type NormalizedCalendarEvent } from './calendar-decoder.js';

const log = createLogger('AlertScheduler');

/**
 * alert-scheduler.ts
 *
 * Decides when a meeting alert fires, and arms a timer for that exact moment.
 *
 * Deliberately knows nothing about where events came from or how banners are drawn. It
 * takes normalised events and calls back; `calendar-poller.ts` and the EventKit bridge
 * feed it, `notification-manager.ts` consumes it. See
 * `docs/magical/notifications.md#alert-scheduler`.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **Alerts land on the second.** A poll tick is the wrong granularity — "five minutes
 *    before" must not mean "some time in the five minutes before".
 * 2. **An alert fires once.** Not once per poll, not again after a restart, and not
 *    again when the same event arrives from a second source.
 */

/** A timer this far out is left unarmed; the next poll re-evaluates it. */
const MAX_TIMER_MS = 10 * 60 * 1000;

/**
 * Tolerance for firing late.
 *
 * A machine asleep through an alert wakes with the moment already past. Firing a banner
 * for a meeting that started forty minutes ago is noise, but one that started ninety
 * seconds ago is still worth having — the user is late, and telling them is the whole
 * point.
 */
const LATE_TOLERANCE_MS = 2 * 60 * 1000;

export interface ScheduledAlert {
  /** Stable across restarts and across sources; see `alertKey`. */
  key: string;
  event: NormalizedCalendarEvent;
  sourceId: string;
  /** When the banner should appear. */
  fireAt: Date;
  /** Minutes before the event start this alert represents. */
  leadMinutes: number;
}

export interface AlertSchedulerOptions {
  /** Minutes before the start to alert. */
  leadMinutes: number;
  onFire: (alert: ScheduledAlert) => void;
  /** Keys already notified in an earlier run, so a restart does not replay them. */
  alreadyNotified?: Iterable<string>;
  /** Called when a key is consumed, so the caller can persist it. */
  onNotified?: (key: string) => void;
  now?: () => number;
}

/**
 * Identifies one alert, for one occurrence, once.
 *
 * Built from the recurrence instance where there is one, which is the case for an
 * occurrence this app expanded itself. An occurrence the wire returned needs no such
 * help: it arrives with its own id, `<seriesId>_<occurrenceStartUTC>Z`. The start time
 * is included so a rescheduled meeting is a new alert rather than a suppressed one, and
 * the lead time so changing the setting does not resurrect old alerts.
 *
 * What must never go in here is the series anchor at `IDX.seriesAnchor`. Every
 * occurrence of a series carries the same one, so keying on it alerts for whichever
 * occurrence is seen first and stays silent for the rest of the year.
 */
export function alertKey(
  event: NormalizedCalendarEvent,
  leadMinutes: number,
  sourceId: string,
): string {
  const occurrence = event.instanceId ?? `${event.id}@${event.startTime.getTime()}`;
  return `${sourceId}|${occurrence}|${leadMinutes}`;
}

/**
 * Decides whether an event is eligible for a meeting alert.
 *
 * All-day entries are excluded: a birthday or an out-of-office block has no moment to be
 * five minutes early for.
 *
 * Declined meetings are excluded too. The code is `1`, measured by declining a live
 * invitation; tentative has still never been observed, so an unrecognised code alerts
 * rather than being guessed at. Dropping an alert for a meeting the user accepted is a
 * missed meeting, which is far worse than one extra banner.
 *
 * Calendars muted by the user in Settings are also excluded, and only when every calendar
 * the event is on is muted. An event held by a muted calendar and an unmuted one is still
 * on the unmuted one, and muting a calendar of someone else's meetings is not a request to
 * lose the alert for a meeting the user is in.
 */
export function isAlertable(
  event: NormalizedCalendarEvent,
  disabledCalendarIds?: ReadonlySet<string> | readonly string[],
): boolean {
  if (event.isAllDay) return false;
  if (event.myResponseStatus === RESPONSE_DECLINED) return false;
  if (disabledCalendarIds && event.calendarIds.length > 0) {
    const disabled =
      disabledCalendarIds instanceof Set ? disabledCalendarIds : new Set(disabledCalendarIds);
    if (event.calendarIds.every((id) => disabled.has(id))) return false;
  }
  return !Number.isNaN(event.startTime.getTime());
}

/**
 * Schedules alerts for a set of events and fires them at their exact moment.
 *
 * `schedule` is idempotent: call it after every poll with the full upcoming window, and
 * it re-arms what changed and leaves the rest alone.
 */
export class AlertScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private armed = new Map<string, ScheduledAlert>();
  /**
   * Alerts that have fired and whose banner may still be on screen.
   *
   * Snooze arrives *after* the alert fires — that is the whole point of the button — so
   * the alert has to outlive its own dispatch or the action has nothing to re-arm.
   */
  private recentlyFired = new Map<string, ScheduledAlert>();
  private notified: Set<string>;
  private leadMinutes: number;
  private readonly onFire: (alert: ScheduledAlert) => void;
  private readonly onNotified?: (key: string) => void;
  private readonly now: () => number;

  constructor(options: AlertSchedulerOptions) {
    this.leadMinutes = options.leadMinutes;
    this.onFire = options.onFire;
    this.onNotified = options.onNotified;
    this.notified = new Set(options.alreadyNotified ?? []);
    this.now = options.now ?? (() => Date.now());
  }

  /** Alerts currently armed, for inspection and tests. */
  public pending(): ScheduledAlert[] {
    return [...this.armed.values()].sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
  }

  /**
   * How long before an event to alert.
   *
   * The event's own notification time where it has one, because a user who set a
   * meeting to warn them 8 minutes ahead meant that meeting, not all of them. Google
   * fires every notification an event carries; this app shows one banner, so it takes
   * the earliest and gives the most warning asked for.
   *
   * Everything else falls back to the global setting. That covers both an event taking
   * its calendar's default and one whose notifications have been removed — the payload
   * this reads does not distinguish them, and does not carry the calendar's default
   * either.
   */
  private leadFor(event: NormalizedCalendarEvent): number {
    const own = event.reminders;
    if (!Array.isArray(own) || own.length === 0) return this.leadMinutes;
    return Math.max(...own);
  }

  public setLeadMinutes(leadMinutes: number): void {
    if (leadMinutes === this.leadMinutes) return;
    log.info(
      `Lead time ${this.leadMinutes} -> ${leadMinutes} min; dropping ${this.armed.size} armed alert(s)`,
    );
    this.leadMinutes = leadMinutes;
    // Every armed alert is now at the wrong moment and carries a key derived from the
    // old lead, so both the timers and the record of them go. The next schedule() re-arms
    // from scratch; leaving `armed` populated would let reconcile() resurrect the old
    // moments after a wake.
    this.clearTimers();
    this.armed.clear();
  }

  /**
   * Re-arms timers for `events`.
   *
   * Events that have disappeared from the window — cancelled, or moved out of range —
   * have their timers dropped, so a deleted meeting does not still ring.
   */
  public schedule(sourceId: string, events: NormalizedCalendarEvent[]): void {
    const keep = new Set<string>();
    const armedBefore = new Set(this.armed.keys());
    let alertable = 0;
    let soonest: { id: string; fireAt: Date; delayMs: number } | null = null;

    for (const event of events) {
      if (!isAlertable(event)) continue;
      alertable++;

      const leadMinutes = this.leadFor(event);
      const key = alertKey(event, leadMinutes, sourceId);
      keep.add(key);
      if (this.notified.has(key)) continue;

      const fireAt = new Date(event.startTime.getTime() - leadMinutes * 60_000);
      const delay = fireAt.getTime() - this.now();

      // Tracked before the horizon checks, so the log can say what the nearest candidate
      // was even on a poll that armed nothing. Otherwise "armed 0" is indistinguishable
      // from "saw nothing", which is the state that makes a missing banner unexplainable.
      if (delay >= -LATE_TOLERANCE_MS && (!soonest || delay < soonest.delayMs)) {
        soonest = { id: event.id, fireAt, delayMs: delay };
      }

      if (delay < -LATE_TOLERANCE_MS) continue;
      // Beyond the horizon: a timer that long is at the mercy of sleep and clock
      // changes, and the next poll will arm it accurately.
      if (delay > MAX_TIMER_MS) continue;

      const alert: ScheduledAlert = { key, event, sourceId, fireAt, leadMinutes };
      this.arm(alert, Math.max(0, delay));
    }

    // Drop anything armed for this source that is no longer in the window.
    for (const [key, alert] of this.armed) {
      if (alert.sourceId === sourceId && !keep.has(key)) this.cancel(key);
    }

    this.logScheduleOutcome(sourceId, events.length, alertable, armedBefore, soonest);
  }

  /**
   * Reports what one poll made of its events.
   *
   * One line per source per poll, which is the only way a missing banner can be
   * explained afterwards: it distinguishes "no events", "none alertable", "the nearest
   * one is still beyond the timer horizon" and "armed, and here is when it fires".
   *
   * Event titles stay out of it. A meeting title is calendar content and the log is
   * written to be attached to a bug report; the event id follows the occurrence as far
   * as the banner without carrying any of it.
   */
  private logScheduleOutcome(
    sourceId: string,
    eventCount: number,
    alertable: number,
    before: Set<string>,
    soonest: { id: string; fireAt: Date; delayMs: number } | null,
  ): void {
    const added = [...this.armed.keys()].filter((key) => !before.has(key)).length;
    const dropped = [...before].filter((key) => !this.armed.has(key)).length;

    const nextPart = soonest
      ? `; soonest ${soonest.id} fires ${soonest.fireAt.toISOString()} in ${Math.round(soonest.delayMs / 1000)}s`
      : '; nothing upcoming';
    log.info(
      `${sourceId}: ${eventCount} event(s), ${alertable} alertable, armed ${added}, dropped ${dropped}, ${this.armed.size} pending (lead ${this.leadMinutes} min)${nextPart}`,
    );
  }

  /**
   * Re-evaluates every armed timer against the wall clock.
   *
   * `setTimeout` measures elapsed time, not wall-clock time, so a machine that sleeps
   * for an hour wakes with its timers an hour behind. Call this on `powerMonitor`
   * resume and on a system clock change; anything whose moment has passed fires
   * immediately, within the late tolerance.
   */
  public reconcile(): void {
    const alerts = [...this.armed.values()];
    this.clearTimers();

    for (const alert of alerts) {
      if (this.notified.has(alert.key)) {
        this.armed.delete(alert.key);
        continue;
      }
      const delay = alert.fireAt.getTime() - this.now();
      if (delay < -LATE_TOLERANCE_MS) {
        // Clearing the timer is not enough: left in `armed`, the alert would count as
        // pending for ever, because schedule() keeps every key still in the window.
        this.armed.delete(alert.key);
        this.logDrop(alert, -delay);
        continue;
      }
      this.arm(alert, Math.max(0, delay));
    }
  }

  /**
   * Re-arms one alert a fixed number of minutes out, without marking it notified.
   *
   * Accepts a key that has already fired, which is the normal case: the user is pressing
   * Snooze on a visible banner.
   */
  public snooze(key: string, minutes: number): boolean {
    const alert = this.armed.get(key) ?? this.recentlyFired.get(key) ?? null;
    if (!alert) return false;

    this.notified.delete(key);
    const fireAt = new Date(this.now() + minutes * 60_000);
    this.arm({ ...alert, fireAt }, minutes * 60_000);
    return true;
  }

  public cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.armed.delete(key);
  }

  /**
   * Cancels everything belonging to a source, for when its account is removed.
   *
   * `schedule()` only prunes within the source it is given, so an account that stops
   * being polled leaves its timers armed and its meetings still ring; the banner then
   * names an account the user has signed out of, and clicking it goes nowhere.
   *
   * `notified` keeps its keys. Dropping them would let a meeting that has already rung
   * ring a second time if the same account were added back inside the lead window, and
   * re-ringing is worse than staying quiet.
   */
  public forget(sourceId: string): void {
    for (const [key, alert] of this.armed) {
      if (alert.sourceId === sourceId) this.cancel(key);
    }
    for (const [key, alert] of this.recentlyFired) {
      if (alert.sourceId === sourceId) this.recentlyFired.delete(key);
    }
    // The already-fired suppression list is keyed `<sourceId>|…`, so an account that has
    // gone leaves entries nothing will ever match again.
    for (const key of [...this.notified]) {
      if (key.startsWith(`${sourceId}|`)) this.notified.delete(key);
    }
  }

  public dispose(): void {
    this.clearTimers();
    this.armed.clear();
    this.recentlyFired.clear();
  }

  private arm(alert: ScheduledAlert, delay: number): void {
    this.cancel(alert.key);
    this.armed.set(alert.key, alert);
    this.timers.set(
      alert.key,
      setTimeout(() => this.fire(alert), delay),
    );
  }

  private fire(alert: ScheduledAlert): void {
    this.timers.delete(alert.key);
    this.armed.delete(alert.key);
    if (this.notified.has(alert.key)) return;

    // A timer left behind by sleep can fire before `powerMonitor`'s resume handler has
    // run, so the callback has to judge itself against the wall clock rather than trust
    // that `reconcile()` already did. Without this, closing the lid through an alert and
    // opening it an hour later posts the banner as if nothing had happened.
    const remaining = alert.fireAt.getTime() - this.now();
    if (remaining > 0) {
      // The clock moved backwards under a timer that had already elapsed. Wait for the
      // moment again instead of firing early.
      this.arm(alert, remaining);
      return;
    }
    if (-remaining > LATE_TOLERANCE_MS) {
      this.logDrop(alert, -remaining);
      return;
    }

    log.info(
      `Firing ${alert.event.id} from ${alert.sourceId}, ${alert.leadMinutes} min before start`,
    );

    // Marked before dispatch, not after: a throw in the handler must not leave the alert
    // eligible to fire again on the next poll.
    this.notified.add(alert.key);
    this.rememberFired(alert);
    this.onNotified?.(alert.key);
    this.onFire(alert);
  }

  private logDrop(alert: ScheduledAlert, lateMs: number): void {
    log.info(
      `Dropping ${alert.event.id} from ${alert.sourceId}, ${Math.round(lateMs / 60_000)} min late`,
    );
  }

  /** Bounded, because a long-running app fires a great many of these. */
  private rememberFired(alert: ScheduledAlert): void {
    this.recentlyFired.set(alert.key, alert);
    if (this.recentlyFired.size > 64) {
      const oldest = this.recentlyFired.keys().next().value;
      if (oldest !== undefined) this.recentlyFired.delete(oldest);
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
