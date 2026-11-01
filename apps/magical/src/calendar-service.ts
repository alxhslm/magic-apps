import { app, dialog, powerMonitor, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger, redactUrl } from '@magimail/core/logger';
import { readSecretFile, writeSecretFile } from '@magimail/core';

import { collapseWorkingLocations } from './working-locations.js';
import { CalendarPoller, classifyFailure, type SourceHealth } from './calendar-poller.js';
import { TasksPoller } from './tasks-poller.js';
import {
  TasksRefusedError,
  type TaskEntry,
  type TaskOccurrence,
  type TaskState,
} from './tasks-decoder.js';
import {
  EVENT_TYPE,
  TASK_CHIP_PREFIX,
  TASKS_CALENDAR_ID,
  type NormalizedCalendarEvent,
} from './calendar-decoder.js';
import { expandRecurringEvents } from './calendar-recurrence.js';
import { duplicateMeetingWarning, findDuplicateMeetings } from './event-duplicates.js';
import { AlertScheduler, type ScheduledAlert } from './alert-scheduler.js';
import {
  dispatchAlert,
  dispatchInvite,
  formatInviteLine,
  prepareNotifications,
  setAlertActionHandler,
  setAuthorizationHandler,
} from './notification-manager.js';
import {
  InviteWatcher,
  inviteKey,
  type PendingInvite,
  type RsvpResponse,
} from './invite-watcher.js';
import type { RevealOutcome, RsvpOutcome } from './accounts-manager.js';
import type { RsvpTiming } from './calendar-actions/index.js';
import { updateDockBadge } from './dock.js';
import { isCalendarSilencedByFocus } from './focus-filter-manager.js';
import { updateNativeToolbarInvites } from './native-toolbar.js';
import { uiString } from './strings.js';
import {
  buildEventLink,
  decodeEid,
  extractEid,
  parseEventLink,
  resolveToCalendarUrl,
  type EventLinkAction,
} from './event-links.js';
import { loadSettings, type MagicalSettings } from './settings-store.js';
import type { CalendarAccount } from './accounts.js';
import {
  calendarAlertKey,
  pollableCalendarIds,
  resolveCanonicalCalendarId,
  resolvePrimaryEmail,
} from './calendars.js';
import { openExternalUrl } from './links.js';

const log = createLogger('CalendarService');

/**
 * calendar-service.ts
 *
 * Owns the loop: poll each account, hand the events to the scheduler, post what fires,
 * and act on what the user presses.
 *
 * Kept out of `main.ts` because it is a subsystem with its own lifecycle rather than
 * another line of app setup. See `docs/magical/notifications.md`.
 */

/**
 * `docs/magical/calendar-sync.md#triggers`: often enough to catch a new meeting, rare enough to ignore.
 *
 * Battery-aware, as Magimail's `atom-poller.ts` is. A calendar changes far less often
 * than a mailbox, so both intervals are much longer than Magimail's.
 */
/**
 * How long a completion the user has just asked for outlives a sync that disagrees.
 *
 * Long enough for Google Tasks to record a change driven through Calendar's UI, short
 * enough that a completion made in the browser and retracted there still settles within
 * one poll.
 */
const COMPLETION_GRACE_MS = 30 * 1000;

const POLL_INTERVAL_AC_MS = 5 * 60 * 1000;
const POLL_INTERVAL_BATTERY_MS = 15 * 60 * 1000;

/** How far past and ahead to fetch in the baseline window. */
const WINDOW_DAYS_PAST = 90;
const WINDOW_DAYS_AHEAD = 365;

/**
 * When a source is considered stale.
 *
 * Deliberately several poll intervals, so one transient failure is not an alarm, but
 * well under the time it takes to miss a day of meetings.
 */
const STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * How long a ledger entry counts as loaded.
 *
 * Only days outside the baseline window reach the ledger at all — `missingRangesFor` subtracts
 * the window the poll owns first — so this is the life of a paged day. Without it, a month the
 * user paged to once was never read again for the rest of the launch, and a meeting cancelled on
 * the server after that first read stayed on screen every time they paged back to it. A day read
 * more recently than this is served from the cache; an older one is fetched again.
 *
 * Set to the mains poll interval: the baseline is refreshed that often, so a paged day is held to
 * the same standard as a day inside the window.
 */
const LOADED_TTL_MS = POLL_INTERVAL_AC_MS;

/** Bounded so a long-lived install does not grow the file without limit. */
const MAX_REMEMBERED_ALERTS = 500;

/**
 * How much of the event cache is written to disk, either side of now.
 *
 * Far less than the poll window, which runs 90 days back and a year ahead. What the cache
 * has to survive a restart for is the day in front of the user: the alerts that fire from
 * it, and an agenda that opens on today rather than on nothing. A year of events would be
 * megabytes written every poll to answer a month nobody is looking at.
 *
 * Paging beyond it while offline shows nothing, which the banner already accounts for.
 */
const CACHED_DAYS_PAST = 7;
const CACHED_DAYS_AHEAD = 60;

/**
 * How long a calendar day stays loaded after the last fetch that read it.
 *
 * The cache can only drop a day once it knows the day was read, and it knows
 * that because every fetch records the days it covered. A day inside the poll
 * window is re-recorded on every poll, so it never ages; a day fetched by
 * paging, or one the window has since rolled past, ages from the last time it
 * was read and is dropped after this long. Paging back to a dropped day
 * re-fetches it, which is what already happens for a day this session has not
 * loaded.
 */
const LOADED_RETENTION_DAYS = 90;

/** One day, in the same units `loadedDays` keys on. */
const MS_PER_DAY = 86_400_000;

/**
 * Backoff for a poll in which every account failed.
 *
 * Doubles per consecutive failed round and is capped, so a signed-out account or a dead
 * network is retried at a decreasing rate rather than at full cadence forever. A round in
 * which any account succeeded resets it, because one broken account must not slow the
 * others down.
 */
const BACKOFF_CAP_MS = 60 * 60 * 1000;

/** Ignore a focus re-poll this soon after the last one, so window switching is free. */
const FOCUS_POLL_MIN_GAP_MS = 60 * 1000;

/** How often to retry an action held back while the user edits, and when to give up. */
const HELD_RETRY_MS = 5_000;
const HELD_EXPIRY_MS = 15 * 60 * 1000;

/**
 * An `NSMenu` is as wide as its widest item, so one interview title with two names in it
 * stretches the whole dropdown across the window. Cut at a width that holds an ordinary
 * meeting title whole.
 */
const MAX_INVITE_TITLE = 40;

export function truncateTitle(title: string, limit = MAX_INVITE_TITLE): string {
  const trimmed = title.trim();
  if (trimmed.length <= limit) return trimmed;
  // Back off to a word boundary when there is one near the cut, so the tail is not a
  // half word; fall back to a hard cut for a long unbroken token.
  const hard = trimmed.slice(0, limit);
  const lastSpace = hard.lastIndexOf(' ');
  const body = lastSpace > limit - 12 ? hard.slice(0, lastSpace) : hard;
  return `${body.trimEnd()}\u2026`;
}

/**
 * When an invitation starts, for the line under its title.
 *
 * The wording itself is `formatInviteLine` in `notification-manager.ts`, which the invitation
 * banner shares so one meeting cannot read two ways.
 */
export function formatInviteWhen(event: NormalizedCalendarEvent, now = new Date()): string {
  return formatInviteLine(event.startTime, event.isAllDay, now);
}

/**
 * An action pressed while the user was mid-edit, waiting for them to finish.
 *
 * Answering and deleting are held rather than dropped, for the same reason: a button
 * that does nothing is the same class of failure as an alert that never fires. Both
 * live in one queue because they are held for the same reason, retried on the same
 * clock, and given up on at the same point.
 *
 * Revealing is deliberately not here. It asks to look at something now, and pulling
 * the view somewhere five minutes after the press is worse than not moving at all.
 */
interface HeldAction {
  key: string;
  accountId: string;
  eid: string;
  startTime: Date;
  intent: RsvpResponse | 'delete' | 'complete';
  /** How the cache knows a deleted event, so the popover can be put back on expiry. */
  eventId?: string;
  /** Kept so a retried delete withholds the editor fallback a task has no route for. */
  isTask?: boolean;
  /**
   * The state a held `complete` should leave the task in. Both directions share one
   * intent, and so one key, which is what lets a tick and an untick queued on the same
   * task settle on whichever the user asked for last.
   */
  completed?: boolean;
}

/**
 * One event, as it survives a restart.
 *
 * Dates go over as epoch milliseconds because `JSON.parse` gives strings back, and an
 * event whose `startTime` is a string alerts at `NaN`. Everything else round-trips as
 * itself.
 */
type PersistedEvent = Omit<
  NormalizedCalendarEvent,
  'created' | 'updated' | 'startTime' | 'endTime' | 'completedAt'
> & {
  created: number | null;
  updated: number | null;
  startTime: number;
  endTime: number;
  completedAt?: number | null;
};

interface PersistedEventCache {
  /** Keyed by account id, as `cachedEvents` is. */
  events: Record<string, PersistedEvent[]>;
}

interface PersistedState {
  notified: string[];
  /**
   * Invitations that arrived and are still waiting.
   *
   * Persisted because the badge it feeds outlives the process: quit with two unanswered
   * arrivals and the badge must still read 2 on the next launch, which a set rebuilt from
   * scratch cannot do. Every invitation in the window is by then merely pending, and
   * nothing distinguishes the two that arrived.
   */
  activeArrivals?: string[];
}

/**
 * One calendar day a fetch has read, and how much of it.
 *
 * The span matters because a paged request rarely starts and ends on midnight: a fetch
 * that covers only the first hour of a day must not let a later request skip the rest of
 * it. `at` is the last time any fetch touched the day, which is what the retention sweep
 * ages against.
 */
interface LoadedDay {
  at: number;
  /** The part of the day covered, as epoch milliseconds, clamped to the day. */
  from: number;
  to: number;
}

/** How long a task with a time of day is drawn for, the way Google draws one. */
const TASK_DURATION_MS = 60 * 60 * 1000;

/**
 * The occurrences of recurring tasks that fall in a range, as events to draw.
 *
 * Google expands a recurring task itself, so each occurrence arrives with its own id and
 * its own start and needs no rule expanded locally. None of them appears in the calendar
 * feed, so nothing here can collide with a decoded event; see
 * `docs/magical/google-tasks.md#recurring-tasks-come-from-the-tasks-sync`.
 *
 * They are filed under the Tasks calendar, which is what gives them the colour and the
 * name the popover draws, and what lets hiding that calendar hide them.
 */
function occurrencesInRange(
  occurrences: TaskOccurrence[],
  range: { start: Date; end: Date },
): NormalizedCalendarEvent[] {
  const events: NormalizedCalendarEvent[] = [];

  for (const occurrence of occurrences) {
    const startTime = occurrence.startTime;
    const endTime = new Date(
      startTime.getTime() + (occurrence.isAllDay ? 86_400_000 : TASK_DURATION_MS),
    );
    if (endTime < range.start || startTime > range.end) continue;

    events.push({
      // The Tasks id of this occurrence, which Google gives each one of its own.
      id: occurrence.taskId,
      calendarIds: [TASKS_CALENDAR_ID],
      summary: occurrence.title,
      // No Calendar event id exists for an occurrence, and so no `webUrl` to read one
      // out of. The grid still draws a chip for it, under the Tasks id.
      webUrl: '',
      chipEid: `${TASK_CHIP_PREFIX}${occurrence.taskId}`,
      created: null,
      updated: null,
      startTime,
      endTime,
      isAllDay: occurrence.isAllDay,
      timezone: occurrence.timezone,
      attendees: [],
      eventType: EVENT_TYPE.TASK,
      myResponseStatus: 'notInvited',
      // At the task's own time, which is what a one-off task carries from the calendar
      // wire. The occurrence record says nothing about notifications, and the global
      // lead would warn about a task some minutes before it is due, which is not what a
      // due time means.
      reminders: [0],
      fromTasksSync: true,
      isCompleted: occurrence.completed,
      completedAt: occurrence.completedAt,
    });
  }

  return events;
}

/**
 * The tasks Google draws nowhere, as events to draw.
 *
 * A task with a time of day is materialised onto the calendar, so the range feed carries it
 * under the event it is drawn as and its own record carries that event's binding. Tasks
 * with a binding are skipped here, so a time-blocked task is never listed twice. A task
 * with a date and no time has neither, and this is the only account of it the app has.
 *
 * They are filed under the Tasks calendar, like an occurrence, which gives them the colour
 * and the name the popover draws and lets hiding that calendar hide them. A finished one is
 * drawn too, and the popover's own "show completed tasks" setting is what hides it.
 */
function unboundTasksInRange(
  tasks: Iterable<TaskEntry>,
  range: { start: Date; end: Date },
): NormalizedCalendarEvent[] {
  const events: NormalizedCalendarEvent[] = [];

  for (const task of tasks) {
    if (task.calendarEventId) continue;

    const startTime = task.startTime;
    if (!startTime) continue;

    const endTime = new Date(startTime.getTime() + (task.isAllDay ? 86_400_000 : TASK_DURATION_MS));
    if (endTime < range.start || startTime > range.end) continue;

    events.push({
      // The Tasks id, which is the only handle on a task Google draws nowhere.
      id: task.taskId,
      calendarIds: [TASKS_CALENDAR_ID],
      summary: task.title,
      // No Calendar event exists for it and so no `webUrl` to read an `eid` out of. The
      // grid still draws a chip for it, under the Tasks id, which is what a link reaches
      // it by and what the task write resolves through.
      webUrl: '',
      chipEid: `${TASK_CHIP_PREFIX}${task.taskId}`,
      created: null,
      updated: null,
      startTime,
      endTime,
      isAllDay: task.isAllDay,
      timezone: task.timezone,
      attendees: [],
      eventType: EVENT_TYPE.TASK,
      myResponseStatus: 'notInvited',
      // At the task's own time, which is what a one-off task carries from the calendar
      // wire. The occurrence path sends the same, and for the same reason.
      reminders: [0],
      fromTasksSync: true,
      isCompleted: task.completed,
      completedAt: task.completedAt,
    });
  }

  return events;
}

export class CalendarService {
  private pollers = new Map<string, CalendarPoller>();
  private tasksPollers = new Map<string, TasksPoller>();
  private scheduler: AlertScheduler;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private isOnBattery = false;
  private isSuspended = false;
  private notified: string[] = [];
  private arrivals: string[] = [];
  private badgeMode: MagicalSettings['dockBadgeMode'] = 'allPending';
  private staleReported = new Set<string>();
  /** Consecutive rounds in which no account read successfully. */
  private consecutiveFailedRounds = 0;
  private lastPollAt = 0;
  /** When this process started, as the fallback age for a source that has never read. */
  private readonly startedAt = Date.now();
  private lastUtcOffset: number | null = null;
  private authorizationWarned = false;
  /** Logged only when it changes, since it is the same on most polls. */
  private lastPendingInvites = -1;
  private lastUnreadInvites = -1;
  private activeAccountId = '';
  private invites: InviteWatcher;
  /** Actions pressed while the user was editing, waiting for the editor to close. */
  private heldActions = new Map<string, HeldAction & { queuedAt: number }>();
  private heldTimer: ReturnType<typeof setInterval> | null = null;
  private cachedEvents = new Map<string, NormalizedCalendarEvent[]>();
  /**
   * Which calendar days have been read, per account, as epoch-day -> the part of the
   * day last covered and when. Absent for an account that has never been polled,
   * which is why `pruneEventCache` leaves such a cache alone. See `markRangeLoaded`.
   */
  private loadedDays = new Map<string, Map<number, LoadedDay>>();
  /**
   * Completions the user has just asked for, as `<accountId>:<eventId>` against the
   * moment a sync may start overruling them.
   *
   * Google Tasks takes a moment to record a completion driven through Calendar's own UI,
   * and the poll that follows the click answers in well under a second. Without this the
   * sync that answered would settle the tick away as one it cannot confirm, and the row
   * the user just ticked goes solid again until the next poll.
   */
  private recentCompletions = new Map<string, number>();
  /**
   * Duplicate meetings already reported, so the canary warns once per meeting rather than
   * on every poll. Bounded below, because a corrupt payload can invent them endlessly.
   */
  private reportedDuplicates = new Set<string>();
  /** Timestamp of the most-recently-started `pollAll` — used by `refreshIfStale`. */
  private lastPollStartedAt: number | null = null;
  private isPolling = false;
  public onEventsUpdated?: (events: Map<string, NormalizedCalendarEvent[]>) => void;

  public getCachedEvents(): Map<string, NormalizedCalendarEvent[]> {
    return this.cachedEvents;
  }

  /**
   * Answers an invitation named by the event, which is all the menu bar popover knows.
   *
   * `sendRsvp` is keyed by invitation, so the key has to come from somewhere. It is
   * derived from the event rather than looked up in the outstanding pile, because an
   * invitation the pile is not tracking must still be answerable: one outside the polled
   * window, or one that arrived before its source was seeded. `resolve` then finds nothing
   * to drop, which is the only difference.
   */
  public async answerRsvp(
    accountId: string,
    eventId: string,
    response: RsvpResponse,
  ): Promise<void> {
    const event = (this.cachedEvents.get(accountId) ?? []).find((e) => e.id === eventId);
    if (!event) {
      log.warn(`nothing cached as ${eventId} on ${accountId}; cannot answer it`);
      return;
    }

    const sourceId = `google:${accountId}`;
    await this.deliverRsvp({ event, sourceId, key: inviteKey(event, sourceId) }, response);
  }

  public async deleteEvent(accountId: string, eventId: string): Promise<boolean> {
    const calendarEvents = this.cachedEvents.get(accountId) ?? [];
    const event = calendarEvents.find((e) => e.id === eventId);
    if (!event) return false;

    const eid = extractEid(event);
    if (!eid || !this.performDelete) {
      log.warn(
        `cannot delete event ${eventId} in background without eid/handler; opening in window`,
      );
      this.openDeepLink(buildEventLink(event, accountId));
      return false;
    }

    // Optimistically remove from cachedEvents so the popover immediately updates
    const updated = calendarEvents.filter((e) => e.id !== eventId);
    this.cachedEvents.set(accountId, updated);
    this.onEventsUpdated?.(this.getCachedEvents());

    const outcome = await this.performDelete(
      accountId,
      eid,
      event.startTime,
      event.eventType === EVENT_TYPE.TASK,
    );
    if (outcome === 'failed') {
      log.warn(`background delete failed for ${eventId}; opening in window`);
      this.openDeepLink(buildEventLink(event, accountId));
      void this.pollNow();
      return false;
    }

    if (outcome === 'busy') {
      // Held rather than dropped, the same way an RSVP is. The event stays out of the
      // popover in the meantime, which is what the press asked for; giving up on it
      // later is what puts it back.
      log.info(`holding the delete of ${eventId}: the user is mid-edit`);
      this.holdAction({
        key: `delete:${accountId}:${eventId}`,
        accountId,
        eid,
        intent: 'delete',
        startTime: event.startTime,
        eventId,
        isTask: event.eventType === EVENT_TYPE.TASK,
      });
      return false;
    }

    log.info(`successfully deleted event ${eventId} in background`);
    void this.pollNow();
    return true;
  }

  /**
   * Ticks a task off in Google Tasks, or ticks it back open, from the menu bar.
   *
   * Nothing is taken out of the cache, unlike a delete. The range payload the calendar
   * poller reads carries no completion state at all; it is the Tasks poller that
   * corrects the optimistic write below, on the next sync that names the task.
   */
  public async setTaskCompleted(
    accountId: string,
    eventId: string,
    completed: boolean,
  ): Promise<boolean> {
    const event = (this.cachedEvents.get(accountId) ?? []).find((e) => e.id === eventId);
    if (!event) {
      log.warn(`nothing cached as ${eventId} on ${accountId}; cannot change it`);
      return false;
    }

    const eid = extractEid(event);
    if (!eid || !this.performComplete) {
      log.warn(`cannot change task ${eventId} in background without eid/handler; opening it`);
      this.openDeepLink(buildEventLink(event, accountId));
      return false;
    }

    const outcome = await this.performComplete(accountId, eid, event.startTime, completed);

    if (outcome === 'busy') {
      // Held rather than dropped, the same way a delete is: a menu item that does
      // nothing because the user happened to have an editor open is the failure this
      // queue exists for.
      log.info(
        `holding the ${completed ? 'completion' : 'reopening'} of ${eventId}: the user is mid-edit`,
      );
      this.holdAction({
        key: `complete:${accountId}:${eventId}`,
        accountId,
        eid,
        intent: 'complete',
        startTime: event.startTime,
        eventId,
        completed,
      });
      return false;
    }

    if (outcome === 'failed') {
      log.warn(
        `background ${completed ? 'completion' : 'reopening'} failed for ${eventId}; opening it in the window`,
      );
      this.openDeepLink(buildEventLink(event, accountId));
      return false;
    }

    log.info(`marked task ${eventId} ${completed ? 'complete' : 'open'} in background`);
    this.applyLocalCompletion(accountId, event, completed);
    this.persistEventCache();
    this.onEventsUpdated?.(this.cachedEvents);
    void this.pollNow();
    return true;
  }

  /**
   * Writes a completion the user has just asked for straight into the cache, before
   * Google has been asked about it.
   *
   * The menu bar has to redraw now, and the Tasks poller is the only thing that
   * actually knows. So this holds only until the next sync that answers, which
   * rewrites it either way.
   */
  private applyLocalCompletion(
    accountId: string,
    event: NormalizedCalendarEvent,
    completed: boolean,
  ): void {
    event.isCompleted = completed;
    event.completedAt = completed ? new Date() : null;
    this.recentCompletions.set(`${accountId}:${event.id}`, Date.now() + COMPLETION_GRACE_MS);
  }

  constructor(
    private getAccounts: () => CalendarAccount[],
    private navigateAccount: (accountId: string, url: string) => void,
    private performRsvp: (
      accountId: string,
      eid: string,
      response: RsvpResponse,
      startTime: Date,
      timing?: RsvpTiming,
    ) => Promise<RsvpOutcome>,
    /** Optional so a test can build a service without a live view to drive. */
    private revealEvent?: (accountId: string, eid: string, at: Date) => Promise<RevealOutcome>,
    private onHealthChanged?: (
      accountId: string,
      health: SourceHealth,
      lastSuccessfulReadAt: Date | null,
    ) => void,
    private performDelete?: (
      accountId: string,
      eid: string,
      startTime: Date,
      isTask: boolean,
    ) => Promise<'ok' | 'busy' | 'failed'>,
    private performComplete?: (
      accountId: string,
      eid: string,
      startTime: Date,
      completed: boolean,
    ) => Promise<'ok' | 'busy' | 'failed'>,
    /** Ensures a window for a link before its account is looked up. Optional for tests. */
    private ensureWindowForLink?: (accountId: string) => void,
  ) {
    const persisted = this.loadState();
    this.notified = persisted.notified;
    this.arrivals = persisted.activeArrivals ?? [];
    this.cachedEvents = this.loadEventCache();
    const settings = loadSettings();
    this.badgeMode = settings.dockBadgeMode;

    this.invites = new InviteWatcher(this.notified, (key) => this.rememberNotified(key), {
      known: this.arrivals,
      onChanged: (keys) => this.rememberArrivals(keys),
    });

    this.scheduler = new AlertScheduler({
      leadMinutes: settings.meetingAlertLeadMinutes,
      onFire: (alert) => this.onAlertFired(alert),
      alreadyNotified: this.notified,
      onNotified: (key) => this.rememberNotified(key),
    });
  }

  public start(): void {
    prepareNotifications();
    setAlertActionHandler((action) => this.onAlertAction(action));
    setAuthorizationHandler((granted) => this.onAuthorization(granted));
    this.setupPowerMonitor();

    this.syncPollers();
    // Arm from what the last run cached, before the first poll has answered. Launching
    // into an outage otherwise means no alert fires until the network comes back, which
    // is the one thing this subsystem must not do; the already-notified set stops this
    // replaying anything that has already fired.
    this.rearmCachedAlerts();
    void this.pollAll();
  }

  public stop(): void {
    if (this.heldTimer) clearInterval(this.heldTimer);
    this.heldTimer = null;
    this.clearPollTimer();
    this.scheduler.dispose();
  }

  /** Polls now and re-arms, cancelling whatever was pending. */
  public pollNow(): void {
    this.clearPollTimer();
    void this.pollAll();
  }

  /**
   * Kicks off a background poll only when the last one was more than
   * `minIntervalMs` milliseconds ago and a poll is not already running.
   * Called on popover open so that events stay fresh without hammering
   * Google on rapid toggles.
   */
  public refreshIfStale(minIntervalMs = FOCUS_POLL_MIN_GAP_MS): void {
    if (this.isPolling) return;
    if (this.lastPollStartedAt === null || Date.now() - this.lastPollStartedAt > minIntervalMs) {
      void this.pollAll();
    }
  }

  private clearPollTimer(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private scheduleNext(): void {
    this.clearPollTimer();
    if (this.isSuspended) return;
    this.pollTimer = setTimeout(() => void this.pollAll(), this.nextInterval());
  }

  /** The base cadence, doubled once per consecutive wholly-failed round. */
  private nextInterval(): number {
    const base = this.isOnBattery ? POLL_INTERVAL_BATTERY_MS : POLL_INTERVAL_AC_MS;
    if (this.consecutiveFailedRounds === 0) return base;
    const scaled = base * 2 ** Math.min(this.consecutiveFailedRounds, 8);
    return Math.min(scaled, BACKOFF_CAP_MS);
  }

  /**
   * Re-polls when the user comes back to the window, unless one just ran.
   *
   * A closed lid is the common case and `powerMonitor` resume covers it, but switching
   * back from another app after a while is the one the user actually notices.
   */
  public pollOnFocus(): void {
    if (Date.now() - this.lastPollAt < FOCUS_POLL_MIN_GAP_MS) return;
    this.pollNow();
  }

  /**
   * Rebuilds every timer when the machine's UTC offset changes.
   *
   * `fireAt` is an absolute instant and the scheduler compares epoch milliseconds, so a
   * new offset changes the local clock time of an alert, not the instant it fires. The
   * rebuild derives each timer from that unchanged instant and recalculates no alert
   * time. Electron has no timezone-change event, so the offset is compared on each poll;
   * a shift found a poll late still leaves every `fireAt` correct.
   */
  private checkTimezoneShift(): void {
    const offset = new Date().getTimezoneOffset();
    if (this.lastUtcOffset === null) {
      this.lastUtcOffset = offset;
      return;
    }
    if (offset === this.lastUtcOffset) return;

    log.info(`UTC offset moved from ${this.lastUtcOffset} to ${offset}; re-arming alerts`);
    this.lastUtcOffset = offset;
    this.scheduler.reconcile();
  }

  /** Mirrors `atom-poller.ts`: back off on battery, stop dead while suspended. */
  private setupPowerMonitor(): void {
    try {
      if (typeof powerMonitor.isOnBatteryPower === 'function') {
        this.isOnBattery = powerMonitor.isOnBatteryPower();
      }
    } catch {
      // Leave the AC default; a wrong guess only affects cadence.
    }

    powerMonitor.on('on-battery', () => {
      this.isOnBattery = true;
      this.scheduleNext();
    });
    powerMonitor.on('on-ac', () => {
      this.isOnBattery = false;
      this.scheduleNext();
    });
    powerMonitor.on('suspend', () => {
      this.isSuspended = true;
      this.clearPollTimer();
    });
    powerMonitor.on('resume', () => {
      this.isSuspended = false;
      // Before polling, not after: setTimeout counts elapsed rather than wall-clock
      // time, so every armed alert is behind. A meeting that started while the lid was
      // shut still gets its banner if it is inside the late tolerance.
      this.scheduler.reconcile();
      void this.pollAll();
    });
  }

  /** Re-reads settings that affect scheduling. */
  public applySettings(): void {
    const settings = loadSettings();
    log.info(
      `Alerts ${settings.meetingAlertsEnabled ? 'on' : 'off'}, lead ${settings.meetingAlertLeadMinutes} min; re-arming`,
    );
    this.scheduler.setLeadMinutes(settings.meetingAlertLeadMinutes);
    this.applyBadgeSetting();
    this.rearmCachedAlerts();
    void this.pollAll();
  }

  /**
   * Re-arms the scheduler from cached events against the current disabledAlertCalendarIds.
   *
   * Drops timers for newly muted calendars and arms newly unmuted ones immediately,
   * without waiting for a network poll round-trip.
   */
  private rearmCachedAlerts(): void {
    if (!loadSettings().meetingAlertsEnabled) {
      for (const [accountId] of this.cachedEvents) {
        const poller = this.pollers.get(accountId);
        const pollerId = poller?.id ?? `google:${accountId}`;
        this.scheduler.forget(pollerId);
      }
      return;
    }
    const disabled = new Set(loadSettings().disabledAlertCalendarIds);
    for (const [accountId, events] of this.cachedEvents) {
      const poller = this.pollers.get(accountId);
      const pollerId = poller?.id ?? `google:${accountId}`;
      const account = this.getAccounts().find((a) => a.id === accountId);
      const alertable = events.filter((e) => !this.isCalendarAlertDisabled(e, account, disabled));
      this.scheduler.schedule(pollerId, alertable);
    }
  }

  /**
   * Whether the active macOS Focus filter silences every calendar this invitation is on.
   *
   * Only the Dock badge asks. The banner is dropped by `MagicalHelper` at the moment it
   * would be posted, and the popover filters itself; both are drawn there.
   */
  private isSilencedByFocus(invite: PendingInvite): boolean {
    const accountId = invite.sourceId.replace(/^google:/, '');
    const account = this.getAccounts().find((a) => a.id === accountId);
    return (
      invite.event.calendarIds.length > 0 &&
      invite.event.calendarIds.every((id) => isCalendarSilencedByFocus(id, accountId, account))
    );
  }

  /**
   * Redraws what a Focus filter changes, without re-polling or re-arming anything.
   *
   * Deliberately lighter than `applySettings`: a Focus decides what is worth interrupting
   * for, not what is scheduled. The alerts stay armed, so one turning off part-way through
   * the day leaves every remaining meeting still able to fire.
   */
  public applyFocusFilter(): void {
    this.publishPending();
  }

  /**
   * Whether the user has muted every calendar this event is on.
   *
   * Every rather than any: an event held by a muted calendar and an unmuted one is still on
   * the unmuted one, and muting a calendar of meetings someone else runs should not take
   * the alert off a meeting the user is in.
   *
   * A mute names the account as well as the calendar, because Google gives Birthdays,
   * Tasks and each locale's holidays the same id in every account. A bare calendar id is
   * the older shape and still mutes in every account, so a mute saved before this change
   * keeps working; `calendarAlertKey` is the composite the Settings window writes now.
   */
  private isCalendarAlertDisabled(
    event: NormalizedCalendarEvent,
    account: CalendarAccount | undefined,
    disabledCalendars: Set<string>,
  ): boolean {
    if (disabledCalendars.size === 0 || event.calendarIds.length === 0) return false;
    const accountId = account?.id;
    return event.calendarIds.every((id) => {
      const canonical = resolveCanonicalCalendarId(id, account);
      if (disabledCalendars.has(id) || disabledCalendars.has(canonical)) return true;
      if (!accountId) return false;
      return (
        disabledCalendars.has(calendarAlertKey(accountId, id)) ||
        disabledCalendars.has(calendarAlertKey(accountId, canonical))
      );
    });
  }

  /**
   * Re-reads what the Dock badge should count, and redraws it.
   *
   * Deliberately lighter than `applySettings`: nothing about the pile has changed, only
   * which part of it is worth a number, so there is nothing to re-poll or re-arm.
   */
  public applyBadgeSetting(): void {
    this.badgeMode = loadSettings().dockBadgeMode;
    this.publishPending();
  }

  /** Rebuilds pollers after accounts are added, removed or their calendars discovered. */
  public syncPollers(): void {
    const accounts = this.getAccounts();
    const live = new Set(accounts.map((a) => a.id));
    let hasNewCalendars = false;

    for (const account of accounts) {
      const pollable = pollableCalendarIds(account);
      const existing = this.pollers.get(account.id);
      if (existing) {
        if (pollable.length && existing.setCalendarIds(pollable)) {
          hasNewCalendars = true;
        }
      } else {
        this.pollers.set(
          account.id,
          new CalendarPoller({
            id: `google:${account.id}`,
            accountId: account.id,
            partition: account.partition,
            calendarIds: pollable,
            accountEmail: resolvePrimaryEmail(account),
          }),
        );
        if (pollable.length) {
          hasNewCalendars = true;
        }
      }

      if (account.gaiaId) {
        const existingTasks = this.tasksPollers.get(account.id);
        if (existingTasks) {
          if (existingTasks.currentGaiaId !== account.gaiaId) {
            existingTasks.updateGaiaId(account.gaiaId);
          }
          if (account.apiKey && existingTasks.currentApiKey !== account.apiKey) {
            existingTasks.updateApiKey(account.apiKey);
          }
        } else {
          this.tasksPollers.set(
            account.id,
            new TasksPoller({
              id: `tasks:${account.id}`,
              accountId: account.id,
              partition: account.partition,
              gaiaId: account.gaiaId,
              apiKey: account.apiKey,
            }),
          );
        }
      }
    }

    let removed = false;
    for (const [id, poller] of [...this.pollers]) {
      if (live.has(id)) continue;
      this.pollers.delete(id);
      this.tasksPollers.delete(id);
      this.invites.forget(poller.id);
      this.scheduler.forget(poller.id);
      removed = true;
    }

    // An account that has gone takes its events with it. They are still in `cachedEvents`
    // from its last poll and reloaded from `event-cache.json` at launch, so leaving them
    // draws a diary for an account nobody has configured: a second copy of every calendar
    // it shared with the account that replaced it, in the fallback colour, and out of reach
    // of the popover's filter because that filter names the account that still exists.
    let dropped = false;
    if (live.size > 0) {
      for (const accountId of [...this.cachedEvents.keys()]) {
        if (live.has(accountId)) continue;
        this.cachedEvents.delete(accountId);
        this.loadedDays.delete(accountId);
        dropped = true;
        removed = true;
      }
      // Nothing keyed by the account may outlive it either: the "already reported stale"
      // flag would suppress the first report if the id came back, and a completion the app
      // is still holding would outlive the account it belongs to.
      for (const accountId of [...this.staleReported]) {
        if (!live.has(accountId)) this.staleReported.delete(accountId);
      }
      for (const key of [...this.recentCompletions.keys()]) {
        const accountId = key.slice(0, key.indexOf(':'));
        if (!live.has(accountId)) this.recentCompletions.delete(key);
      }
      // A held action names its account and is replayed until it settles, so one left on a
      // removed account would keep being retried against a view that is gone.
      for (const [key, item] of [...this.heldActions]) {
        if (!live.has(item.accountId)) this.heldActions.delete(key);
      }
      // The persisted suppression list is keyed `google:<accountId>|…`; entries for a gone
      // account are never matched again and would otherwise be written back for ever.
      const notified = this.notified.filter((key) => {
        const sep = key.indexOf('|');
        if (sep < 0) return true;
        const source = key.slice(0, sep);
        return !source.startsWith('google:') || live.has(source.slice('google:'.length));
      });
      if (notified.length !== this.notified.length) {
        this.notified = notified;
        dropped = true;
      }
    }

    if (hasNewCalendars) {
      this.pollNow();
    }
    if (dropped) {
      this.persistEventCache();
      this.persistState();
      this.onEventsUpdated?.(this.cachedEvents);
    }
    if (removed) this.publishPending();
  }

  /**
   * Drops everything this service holds for an account that is being removed.
   *
   * `syncPollers` sweeps accounts that are no longer configured, but only once they are
   * gone from the accounts list and only while another account remains. An account being
   * removed has not gone yet, so the purge is asked for by name, before the record is
   * dropped — otherwise its events are still cached for the rest of the session and come
   * back from `event-cache.json` on the next launch, drawing a diary whose filter row no
   * longer exists. Its alert keys go the same way: a suppression key for an account nobody
   * has can never be matched again, and an arrival it is holding would keep a number on the
   * badge that the user cannot work off.
   *
   * Nothing is written back for the account: the partition and its cookies are the
   * accounts manager's to clear, and the pollers are `syncPollers`'.
   */
  public forgetAccount(accountId: string): void {
    this.cachedEvents.delete(accountId);
    this.loadedDays.delete(accountId);
    this.staleReported.delete(accountId);
    for (const key of [...this.recentCompletions.keys()]) {
      if (key.startsWith(`${accountId}:`)) this.recentCompletions.delete(key);
    }
    for (const [key, item] of [...this.heldActions]) {
      if (item.accountId === accountId) this.heldActions.delete(key);
    }

    // Both files are keyed `google:<accountId>|…`, the same shape `syncPollers` reads.
    const source = `google:${accountId}|`;
    this.notified = this.notified.filter((key) => !key.startsWith(source));
    this.arrivals = this.arrivals.filter((key) => !key.startsWith(source));

    this.persistEventCache();
    this.persistState();
    this.onEventsUpdated?.(this.cachedEvents);
    this.publishPending();
  }

  /**
   * The range the recurring poll reads: the baseline window around today.
   *
   * Recomputed on every call rather than cached. Magical is a menu bar app people leave
   * running for weeks, and a window fixed at launch polls `d-90..d+365` relative to the
   * day the app started: a month in, the last month of the year ahead is never fetched
   * while three extra months of history nobody can see are fetched on every poll.
   *
   * It never widens. Paging the agenda to March is a request to see March once, not a
   * standing order to re-read it every five minutes for the rest of the session, and
   * history is the expensive half of a poll: one back-tap to 2019 would otherwise add
   * years of it to every tick.
   */
  private window(): { start: Date; end: Date } {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - WINDOW_DAYS_PAST);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    end.setDate(end.getDate() + WINDOW_DAYS_AHEAD);
    return { start, end };
  }

  /**
   * Fetches the part of a range the baseline window does not reach, for the agenda or the
   * mini-month to show, and merges it into the cache.
   *
   * One fetch, not a subscription: the cache keeps what came back and the recurring poll
   * stays where it was. Nothing needs a month paged to re-read every five minutes, because the
   * popover is `.transient` and dismisses the moment the user clicks away; reopening it
   * sends `tray.popoverOpened`, which re-polls when the cache is stale.
   *
   * A page to a month the ledger already holds reads nothing and is answered from the cache; a
   * request that overlaps loaded days reads only the days missing. `loadedDays` is consulted per
   * account, so one account having fetched a month does not stop another from being asked for it.
   *
   * Concurrent requests buffer the latest range in a trailing slot rather than queueing every
   * intermediate month or dropping requests: when the in-flight fetch finishes, it fetches
   * the destination month directly.
   */
  private isFetchingRange = false;
  private pendingRange: { start: Date; end: Date } | null = null;
  private activeFetchPromise: Promise<void> | null = null;

  public async ensureRange(requestedStart: Date, requestedEnd: Date): Promise<void> {
    const startMs = requestedStart.getTime();
    const endMs = requestedEnd.getTime();
    // Reject anything outside the 1900–2100 span, so a malformed message from the helper
    // cannot ask Google for ten thousand years.
    if (
      Number.isNaN(startMs) ||
      Number.isNaN(endMs) ||
      startMs < -2208988800000 ||
      endMs > 4102444800000
    ) {
      return;
    }

    const missing = this.missingRangesFor(requestedStart, requestedEnd);
    // Wholly inside the baseline, or already loaded from an earlier page: the poll or that
    // page has it and the cache is already current.
    if (missing.size === 0) return;

    if (this.isFetchingRange) {
      this.pendingRange = { start: requestedStart, end: requestedEnd };
      await this.activeFetchPromise;
      return;
    }

    this.isFetchingRange = true;
    this.activeFetchPromise = (async () => {
      try {
        let currentMissing = missing;
        while (currentMissing.size > 0) {
          await this.fetchMissingRanges(currentMissing);

          if (this.pendingRange) {
            const next = this.pendingRange;
            this.pendingRange = null;
            currentMissing = this.missingRangesFor(next.start, next.end);
          } else {
            currentMissing = new Map();
          }
        }
      } finally {
        this.isFetchingRange = false;
        this.pendingRange = null;
        this.activeFetchPromise = null;
      }
    })();

    await this.activeFetchPromise;
  }

  private async fetchMissingRanges(
    missing: Map<string, { start: Date; end: Date }[]>,
  ): Promise<void> {
    for (const [accountId, ranges] of missing) {
      const poller = this.pollers.get(accountId);
      if (!poller) continue;
      for (const range of ranges) {
        try {
          const expanded = expandRecurringEvents(await poller.events(range), range);
          await this.syncTasksCompletion(accountId, expanded, range);
          this.cachedEvents.set(accountId, this.foldIntoCache(accountId, range, expanded));
          this.markRangeLoaded(accountId, range);
        } catch (err) {
          log.warn(
            `could not read ${range.start.toDateString()} to ${range.end.toDateString()} for ${accountId}:`,
            err,
          );
        }
      }
    }

    this.onEventsUpdated?.(this.cachedEvents);
  }

  /**
   * The parts of a requested range that lie outside the baseline window.
   *
   * The helper asks for 60 days either side of the date the user paged to, so most of a
   * request is days the poll already reads. Fetching the lot costs about 44 KiB a day
   * across two accounts (`docs/magical/calendar-sync.md#window-and-paging`), which is several MiB
   * to see one month nobody has fetched yet.
   *
   * The baseline is read here rather than remembered, because `window()` rolls with the
   * calendar day. Clamping against a window computed an hour ago would leave the day it
   * has since rolled onto unfetched.
   *
   * A range wider than the baseline needs a piece at each end, and those are returned and
   * fetched separately rather than joined into one. Joining them would re-read the whole
   * baseline in between, which is the expense this exists to avoid, and each read is
   * authoritative over the range it covered: `foldIntoCache` must be told the two ends,
   * not the span they sit at either end of.
   */
  private beyondBaseline(start: Date, end: Date): { start: Date; end: Date }[] {
    const baseline = this.window();
    const pieces: { start: Date; end: Date }[] = [];
    // A millisecond short of the baseline on each side, so a piece never overlaps a day
    // the poll owns and cannot evict what the poll cached there.
    if (start < baseline.start) {
      pieces.push({ start, end: new Date(Math.min(end.getTime(), baseline.start.getTime() - 1)) });
    }
    if (end > baseline.end) {
      pieces.push({ start: new Date(Math.max(start.getTime(), baseline.end.getTime() + 1)), end });
    }
    return pieces;
  }

  /**
   * What each account still has to read to answer a request, keyed by account.
   *
   * The baseline window is subtracted first, because the poll owns those days and keeps
   * them current; what is left is then cut against the days the ledger says that account
   * has already read. A range loaded for every account yields an empty map, which is how
   * a second page to the same month issues no request at all.
   *
   * Per account rather than one shared set of ranges: one account that paged to a month
   * must not be asked for it again because another has never read it, and a read is
   * authoritative only over the range it covered, so the two cannot share a fetch.
   */
  private missingRangesFor(start: Date, end: Date): Map<string, { start: Date; end: Date }[]> {
    const missing = new Map<string, { start: Date; end: Date }[]>();
    const beyond = this.beyondBaseline(start, end);
    if (beyond.length === 0) return missing;
    for (const accountId of this.pollers.keys()) {
      const gaps = beyond.flatMap((piece) => this.subtractLoadedDays(accountId, piece));
      if (gaps.length > 0) missing.set(accountId, gaps);
    }
    return missing;
  }

  /**
   * Cuts the days an account has already loaded out of one range, returning the gaps.
   *
   * A day is only subtracted as far as it was actually read, so a fetch that stopped an
   * hour into a day leaves the rest of it to be asked for again. A run of uncovered time
   * keeps the requested boundary at whichever end of the range it reaches, so a request
   * that does read anything is still read over exactly the span asked for rather than
   * snapped to midnight.
   */
  private subtractLoadedDays(
    accountId: string,
    range: { start: Date; end: Date },
  ): { start: Date; end: Date }[] {
    const days = this.loadedDays.get(accountId);
    // An account with no ledger has read nothing this launch, so nothing is missing from
    // the request: it all is.
    if (!days || days.size === 0) return [range];

    const now = Date.now();
    const gaps: { start: Date; end: Date }[] = [];
    const endMs = range.end.getTime();
    let cursor = range.start.getTime();
    const day = new Date(range.start);
    day.setHours(0, 0, 0, 0);
    while (cursor <= endMs && day.getTime() <= endMs) {
      const covered = days.get(this.dayKey(day));
      // A ledger entry ages. Only days outside the baseline reach this function, so the check
      // costs the poll nothing; for a paged day it is the difference between serving a copy that
      // may name a cancelled meeting and reading the day again.
      if (covered && now - covered.at <= LOADED_TTL_MS) {
        const from = Math.max(covered.from, cursor);
        const to = Math.min(covered.to, endMs);
        if (from > cursor) gaps.push({ start: new Date(cursor), end: new Date(from - 1) });
        if (to >= cursor) cursor = to + 1;
      }
      day.setDate(day.getDate() + 1);
    }
    if (cursor <= endMs) gaps.push({ start: new Date(cursor), end: range.end });
    return gaps;
  }

  /**
   * Folds a fetched range into an account's cache.
   *
   * A read is authoritative over the range it covered and over nothing else. Everything
   * overlapping that range comes from the fresh result alone, so an event cancelled on
   * the server disappears rather than lingering; so does a stale entry no key can evict,
   * such as the generated instance id of an all-day occurrence the user has converted to
   * a timed event. Everything outside the range is kept, because this read says nothing
   * about it.
   *
   * That second half is what lets the poll stay at the baseline. A month the user paged
   * to sits outside every subsequent poll, and dropping it would make paging useless:
   * what you fetched would vanish seconds later. So the stored events are what has been fetched,
   * which is a wider thing than what the poll covers. It is bounded by `pruneEventCache` rather
   * than by the process: a day is kept while a fetch has covered it recently, and the months the
   * user visits and the history the window rolls off age out with it.
   */
  /**
   * Settles the task events of a fetched range against Google Tasks, and adds the
   * occurrences of recurring tasks, which the range carries nothing about.
   *
   * The calendar wire carries no completion at all, so a freshly fetched task event
   * arrives blank and would un-tick itself on every poll. The cached state is copied
   * over first to stop that, and the sync then settles it.
   *
   * `events` is appended to, since the caller folds it into the cache.
   */
  private async syncTasksCompletion(
    accountId: string,
    events: NormalizedCalendarEvent[],
    range: { start: Date; end: Date },
  ): Promise<void> {
    const tasksPoller = this.tasksPollers.get(accountId);
    if (!tasksPoller) return;

    const taskEvents = events.filter((e) => e.eventType === EVENT_TYPE.TASK);

    const existing = new Map((this.cachedEvents.get(accountId) ?? []).map((e) => [e.id, e]));
    for (const event of taskEvents) {
      const cached = existing.get(event.id);
      if (!cached) continue;
      event.isCompleted = cached.isCompleted;
      event.completedAt = cached.completedAt;
    }

    let tasks: Map<string, TaskState>;
    let tasksById: Map<string, TaskEntry>;
    let occurrences: TaskOccurrence[];
    try {
      ({ tasks, tasksById, occurrences } = await tasksPoller.fetchTasks());
    } catch (err) {
      // The cached state stands. It is the last thing Google actually said, and
      // guessing is worse than showing it.
      //
      // A refusal has already been said once by the poller and is paused there, so it is
      // not repeated here on every poll; a decode or network failure is worth a line
      // each time it happens.
      if (!(err instanceof TasksRefusedError)) {
        log.warn(`could not sync tasks completion for ${accountId}:`, err);
      }
      return;
    }

    for (const event of occurrencesInRange(occurrences, range)) {
      events.push(event);
    }

    for (const event of unboundTasksInRange(tasksById.values(), range)) {
      events.push(event);
    }

    if (taskEvents.length === 0) return;

    // An answer that recognises none of the tasks on the calendar is a decode that
    // failed, not an account with nothing in it: Tasks holds a record for an open task
    // as much as a finished one. Settling on it would clear every tick the user has.
    const named = taskEvents.filter(
      (e) => tasks.has(e.id) || tasks.has(e.id.split('_')[0]) || tasksById.has(e.id),
    ).length;
    if (named === 0) {
      log.warn(
        `the tasks sync for ${accountId} named none of ${taskEvents.length} task event(s); leaving the cached state alone`,
      );
      return;
    }

    // A sync that answered is Google's whole answer, so it settles every task event
    // rather than only the ones it names. A task the sync omits is one Tasks does not
    // hold as complete; carrying the cached tick forward instead is what left a task
    // reopened in the browser greyed out in the popover for good.
    const now = Date.now();
    for (const event of taskEvents) {
      const baseId = event.id.split('_')[0];
      const task = tasks.get(event.id) ?? tasks.get(baseId) ?? tasksById.get(event.id);
      const completed = task?.completed ?? false;

      const key = `${accountId}:${event.id}`;
      const protectedUntil = this.recentCompletions.get(key);
      if (protectedUntil !== undefined) {
        if (completed === event.isCompleted || protectedUntil <= now) {
          this.recentCompletions.delete(key);
        } else {
          // Google has not caught up with the click yet. Leaving the user's own tick
          // alone for the moment beats flickering it back and correcting it five
          // minutes later.
          continue;
        }
      }

      event.isCompleted = completed;
      event.completedAt = task?.completedAt ?? null;
    }
  }

  private foldIntoCache(
    accountId: string,
    range: { start: Date; end: Date },
    fetched: NormalizedCalendarEvent[],
  ): NormalizedCalendarEvent[] {
    const byId = new Map<string, NormalizedCalendarEvent>();
    for (const e of this.cachedEvents.get(accountId) ?? []) {
      if (e.endTime >= range.start && e.startTime <= range.end) continue;
      byId.set(e.id, e);
    }
    for (const e of fetched) byId.set(e.id, e);
    // One working location per day, the way Google draws them. It has to run over the
    // merged list rather than the fetched one: the entry a one-off replaces can have come
    // from an earlier poll and be sitting in the cache.
    const merged = collapseWorkingLocations(
      [...byId.values()].sort((a, b) => a.startTime.getTime() - b.startTime.getTime()),
    );
    this.reportDuplicateMeetings(accountId, merged);
    return merged;
  }

  /**
   * Warns, once per meeting, when the merged agenda names one meeting twice.
   *
   * This is the choke point every poll and every paged range passes through, so it is the
   * one place that sees the final list rather than one fetch of it. A warning names the
   * account, the count and the start — never the event's title or id, which are the user's
   * own data and must not reach a log that a bug report may carry off the machine.
   */
  private reportDuplicateMeetings(accountId: string, events: NormalizedCalendarEvent[]): void {
    for (const { key, events: group } of findDuplicateMeetings(events)) {
      const reportKey = `${accountId}\u0000${key}`;
      if (this.reportedDuplicates.has(reportKey)) continue;
      this.reportedDuplicates.add(reportKey);
      if (this.reportedDuplicates.size > 1000) {
        const oldest = this.reportedDuplicates.values().next().value;
        if (oldest !== undefined) this.reportedDuplicates.delete(oldest);
      }
      log.warn(duplicateMeetingWarning(accountId, group));
    }
  }

  private async pollAll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;
    try {
      // Rescheduling happens either way. An early return here would stop the loop dead,
      // and turning alerts back on would not restart it until the next launch.
      if (!loadSettings().meetingAlertsEnabled) {
        log.info('Alerts are off; skipping the poll');
        this.scheduleNext();
        return;
      }

      this.lastPollAt = Date.now();
      this.lastPollStartedAt = Date.now();
      this.checkTimezoneShift();
      const range = this.window();
      let anySucceeded = false;
      for (const [accountId, poller] of this.pollers) {
        try {
          const rawEvents = await poller.events(range);
          anySucceeded = true;
          const expanded = expandRecurringEvents(rawEvents, range);
          await this.syncTasksCompletion(accountId, expanded, range);
          const merged = this.foldIntoCache(accountId, range, expanded);
          this.cachedEvents.set(accountId, merged);
          this.markRangeLoaded(accountId, range);

          const disabled = new Set(loadSettings().disabledAlertCalendarIds);
          const account = this.getAccounts().find((a) => a.id === accountId);
          const alertableMerged = merged.filter(
            (e) => !this.isCalendarAlertDisabled(e, account, disabled) && !e.isCompleted,
          );
          const alertableExpanded = expanded.filter(
            (e) => !this.isCalendarAlertDisabled(e, account, disabled) && !e.isCompleted,
          );

          this.scheduler.schedule(poller.id, alertableMerged);

          for (const invite of this.invites.observe(poller.id, alertableExpanded)) {
            dispatchInvite({
              key: invite.key,
              accountId,
              calendarIds: invite.event.calendarIds,
              eventId: invite.event.id,
              summary: invite.event.summary,
              organizerEmail: invite.event.organizerEmail,
              startTime: invite.event.startTime,
              isAllDay: invite.event.isAllDay,
              deepLink: buildEventLink(invite.event, accountId),
            });
          }
          this.staleReported.delete(accountId);
          this.reportHealth(accountId, 'ok', poller);
        } catch (err) {
          this.reportUnhealthy(accountId, poller, err);
        }
      }
      // One healthy account is enough to keep full cadence; backing the whole loop off
      // because a second account is signed out would punish the account that still works.
      this.consecutiveFailedRounds =
        anySucceeded || this.pollers.size === 0 ? 0 : this.consecutiveFailedRounds + 1;

      this.checkStaleness();
      // Only when something was read. A round in which every account failed has changed
      // nothing worth writing, and rewriting the file would cost a megabyte of disk per
      // failed poll for no new information.
      if (anySucceeded) {
        this.pruneEventCache();
        this.persistEventCache();
      }
      this.onEventsUpdated?.(this.cachedEvents);
      this.publishPending();
      this.scheduleNext();
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * How many invitations are outstanding on each account, keyed by account id.
   *
   * Rides on each account in `tray.update` as `unreadCount`, which nothing in the popover
   * draws today: it filters by calendar rather than by account, so there is no per-account
   * label to put a number on.
   *
   * The whole pile rather than what arrived while you were away. This says how much is
   * waiting on an account, not how loudly to nag about it; `dockBadgeMode` stays a
   * property of the Dock badge.
   *
   * Read from `InviteWatcher` for the same reason every other surface is: it drops an
   * invitation the moment one is answered, rather than at the next poll, and it holds
   * what the poll actually returned rather than whatever the agenda has scrolled into
   * view. Counting the event cache again here is how the popover and the Dock came to
   * disagree.
   */
  public pendingByAccount(): Map<string, number> {
    const byAccount = new Map<string, number>();
    for (const invite of this.invites.pending()) {
      const accountId = invite.sourceId.replace(/^google:/, '');
      byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + 1);
    }
    return byAccount;
  }

  /**
   * How many invitations have arrived on each account, keyed by account id.
   *
   * Feeds the dot on each segment of the toolbar's account switcher, which is the only
   * thing that says *where* something is waiting: the dropdown shows the active account
   * alone, and the Dock badge is one number for the app.
   */
  public newArrivalsByAccount(): Map<string, number> {
    const byAccount = new Map<string, number>();
    for (const [sourceId, count] of this.invites.arrivalsBySource()) {
      byAccount.set(sourceId.replace(/^google:/, ''), count);
    }
    return byAccount;
  }

  /** Fired when the arrivals change, so the switcher can redraw its dots. */
  public onInvitesChanged?: () => void;

  /**
   * Points the dropdown at a different account.
   *
   * Called whenever the active account changes, which is also when the toolbar redraws
   * its account switcher.
   */
  public setActiveAccount(accountId: string): void {
    if (accountId === this.activeAccountId) return;
    this.activeAccountId = accountId;
    this.publishPending();
  }

  /**
   * Publishes the outstanding invitations, from the one place that knows them.
   *
   * The two surfaces deliberately show different slices. The Dock badge belongs to the
   * app, so it counts every account: it is the number you see with the window closed, and
   * it has to mean "this much is waiting for you" rather than "this much is waiting on
   * whichever account happens to be open". The dropdown sits in a window showing one
   * account, so it lists that account alone; offering to answer an invitation that is not
   * in the calendar behind it invites a reply in the wrong identity.
   *
   * Both are read from the same array on the same call, so neither can lag the other.
   * Every path that can change the pile ends here, so neither waits for the next poll.
   */
  private publishPending(): void {
    const pending = this.invites.pending();
    const totalUnreadCount = pending.filter((invite) =>
      this.invites.isNewArrival(invite.key),
    ).length;
    if (pending.length !== this.lastPendingInvites || totalUnreadCount !== this.lastUnreadInvites) {
      log.info(
        `${pending.length} invitation(s) awaiting a reply (${totalUnreadCount} unread arrival(s))`,
      );
      this.lastPendingInvites = pending.length;
      this.lastUnreadInvites = totalUnreadCount;
    }

    // Counted at publish time rather than dropped from the watcher. The watcher decides
    // what is new, and an invitation it never saw because a Focus was on would count as
    // new all over again when the Focus ended.
    const counted = pending.filter((invite) => !this.isSilencedByFocus(invite));
    updateDockBadge(
      this.badgeMode === 'newInvitations'
        ? counted.filter((invite) => this.invites.isNewArrival(invite.key)).length
        : counted.length,
    );

    const mine = this.activeAccountId ? `google:${this.activeAccountId}` : null;
    const accountInvites = pending.filter((invite) => !mine || invite.sourceId === mine);
    const accountUnreadCount = accountInvites.filter((invite) =>
      this.invites.isNewArrival(invite.key),
    ).length;
    const toolbarCount =
      this.badgeMode === 'newInvitations' ? accountUnreadCount : accountInvites.length;

    updateNativeToolbarInvites(
      accountInvites.map((invite) => ({
        key: invite.key,
        summary: truncateTitle(invite.event.summary || uiString('toolbar.invite.noTitle')),
        detail: formatInviteWhen(invite.event),
        // The same flag the badge counts, so what the dropdown draws in full colour and
        // what the badge says can never disagree; see `docs/magical/rsvp.md#toolbar-dropdown`.
        isNew: this.invites.isNewArrival(invite.key),
      })),
      toolbarCount,
    );
    this.onInvitesChanged?.();
  }

  /**
   * Surfaces a failed read rather than letting it look like an empty calendar.
   *
   * Invariant 7 of the poller spec: silence is not an acceptable failure state for the
   * component alerts are built on.
   */
  private reportUnhealthy(accountId: string, poller: CalendarPoller, err: unknown): void {
    const health = classifyFailure(err);
    if (!this.staleReported.has(accountId)) {
      this.staleReported.add(accountId);
      log.warn(`${poller.id} is ${health}:`, err);
    }
    this.reportHealth(accountId, health, poller);
  }

  /**
   * Tells the surfaces how a source is doing, and when it last actually read.
   *
   * The two travel together because neither is much use alone. A surface given only
   * `offline` cannot say how old the agenda behind it is, and one given only a timestamp
   * cannot say whether the gap is a dead network or an expired session.
   */
  private reportHealth(accountId: string, health: SourceHealth, poller: CalendarPoller): void {
    this.onHealthChanged?.(accountId, health, poller.lastSuccessfulReadAt);
  }

  /**
   * Catches the case a failed poll does not: a poller that stopped succeeding without
   * throwing on this particular tick.
   */
  private checkStaleness(): void {
    const now = Date.now();
    for (const [accountId, poller] of this.pollers) {
      const last = poller.lastSuccessfulReadAt?.getTime() ?? 0;
      if (now - last <= STALE_AFTER_MS) continue;
      if (this.staleReported.has(accountId)) continue;
      this.staleReported.add(accountId);
      this.reportHealth(accountId, 'stale', poller);
      log.warn(
        `google:${accountId} has not read successfully since ${last ? new Date(last).toISOString() : 'launch'}`,
      );
    }
  }

  /**
   * Says so, once, when notification permission was refused.
   *
   * Alerts are the reason the poller exists, so failing this quietly would leave the app
   * doing all the work and producing nothing the user can see. Shown once per launch
   * rather than on every arm, and never when permission was granted.
   */
  private onAuthorization(granted: boolean): void {
    if (granted || this.authorizationWarned) return;
    this.authorizationWarned = true;

    log.warn('notification permission denied; no banner will appear');
    void dialog
      .showMessageBox({
        type: 'warning',
        message: uiString('dialog.alertPermission.message'),
        detail: uiString('dialog.alertPermission.detail'),
        buttons: [
          uiString('dialog.alertPermission.openSettings'),
          uiString('dialog.alertPermission.notNow'),
        ],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response !== 0) return;
        void shell.openExternal(
          'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
        );
      });
  }

  private onAlertFired(alert: ScheduledAlert): void {
    const accountId = alert.sourceId.replace(/^google:/, '');
    dispatchAlert(alert, accountId, this.staleForMs(accountId));
  }

  /**
   * How long a source has gone without a successful read, once that is long enough to
   * cast doubt on what it cached. Undefined while it is reading normally.
   *
   * A source that has never read at launch counts as stale from launch rather than from
   * the epoch, so the first alert after a cold start offline does not claim the calendar
   * was last synced in 1970.
   */
  private staleForMs(accountId: string): number | undefined {
    const poller = this.pollers.get(accountId);
    if (!poller) return undefined;
    const since = poller.lastSuccessfulReadAt?.getTime() ?? this.startedAt;
    const age = Date.now() - since;
    return age > STALE_AFTER_MS ? age : undefined;
  }

  private onAlertAction(action: {
    key: string;
    accountId: string;
    deepLink: string;
    conferenceUrl?: string;
    action: string;
  }): void {
    switch (action.action) {
      case 'join':
        if (action.conferenceUrl) void this.joinCall(action.conferenceUrl);
        break;

      case 'snooze':
        this.scheduler.snooze(action.key, 5);
        break;

      case 'rsvp:yes':
      case 'rsvp:maybe':
      case 'rsvp:no':
        void this.sendRsvp(action.key, action.action.split(':')[1] as RsvpResponse);
        break;

      case 'open':
      default:
        this.openDeepLink(action.deepLink);
        break;
    }
  }

  /**
   * Marks every invitation the dropdown is showing as read.
   *
   * Reaches only the active account, which is what the dropdown displays.
   */
  public handleInvitesReadAll(): void {
    const source = this.activeAccountId ? `google:${this.activeAccountId}` : undefined;
    log.info(`Marking all invitations read for ${source ?? 'all accounts'}`);
    this.invites.acknowledge(source);
    this.publishPending();
  }

  /**
   * Handles a choice made in the toolbar's invitations dropdown.
   *
   * The same `sendRsvp` the notification banners use, so an invitation answered from the
   * dropdown goes through the identical queue-while-editing and fall-back-to-opening
   * handling rather than a second, thinner copy of it.
   */
  public handleInviteAction(action: string, key: string): void {
    log.info(`Handling toolbar invite action: ${action}`);
    if (action === 'invite:read') {
      this.invites.markRead(key);
      this.publishPending();
      return;
    }

    if (action === 'invite:open') {
      const invite = this.invites.pending().find((p) => p.key === key);
      if (!invite) return;
      const accountId = invite.sourceId.replace(/^google:/, '');
      this.openDeepLink(buildEventLink(invite.event, accountId));
      return;
    }

    const response = action.split(':')[1];
    if (response === 'yes' || response === 'no' || response === 'maybe') {
      void this.sendRsvp(key, response);
    }
  }

  /** Answers an invitation named by its key, which is what a banner and the dropdown carry. */
  /**
   * Runs a link's action through whichever surface already owns it.
   *
   * A link carries an `eid` and nothing else, while the methods a banner and a popover
   * row use are keyed on what the app already knows: an outstanding invitation, or an
   * event in the cache. Resolving the `eid` back to one of those is what lets a link
   * take the same path rather than a parallel one that drifts from it.
   *
   * Falling through to the view driver covers the case that cannot be resolved -- an
   * event that was never polled, or an invitation already dropped from the pile -- so a
   * link still works, without a second copy of the bookkeeping.
   */
  private async actOnLinkedEvent(
    accountId: string,
    eid: string,
    action: Exclude<EventLinkAction, 'reveal'>,
    at: Date | undefined,
  ): Promise<string> {
    log.info(
      `Acting on linked event: ${action} on ${accountId} (${decodeEid(eid)?.eventId ?? 'unresolved'})`,
    );
    // The eid's calendar half is the copy that raised the link; an attendee's copy of the
    // same event carries the organiser's, so the same event can arrive under two eids.
    // The event id is shared, so it is the fallback that finds the cached row either way.
    const linkedId = decodeEid(eid)?.eventId;
    const cached = (this.cachedEvents.get(accountId) ?? []).find(
      (e) => extractEid(e) === eid || (linkedId !== undefined && e.id === linkedId),
    );

    if (cached) {
      if (action === 'delete') {
        return (await this.deleteEvent(accountId, cached.id)) ? 'ok' : 'failed';
      }
      await this.answerRsvp(accountId, cached.id, action);
      return 'ok';
    }

    // Nothing cached under that `eid`: an event outside the polled window, or one whose
    // source has not been read yet. There is no bookkeeping to keep in step in that
    // case, so drive the view directly rather than refuse.
    if (!at) {
      log.warn(`Cannot act on linked event: no timestamp available to route on ${accountId}`);
      return 'failed';
    }
    if (action === 'delete') {
      // Not a task as far as anything here can tell: the kind is on the cached event,
      // and there isn't one. The chip is matched under either id regardless, so only
      // the editor fallback is offered where a task would not want it.
      return this.performDelete ? this.performDelete(accountId, eid, at, false) : 'failed';
    }
    return this.performRsvp(accountId, eid, action, at);
  }

  private async sendRsvp(key: string, response: RsvpResponse): Promise<void> {
    const invite = this.invites.pending().find((p) => p.key === key);
    if (!invite) {
      log.warn(`Cannot send RSVP: no pending invite found for key ${key}`);
      return;
    }
    await this.deliverRsvp(invite, response);
  }

  /**
   * Answers an invitation.
   *
   * Neither route Google offers is usable, so this drives Google's own controls in the
   * account's view; see `docs/magical/notifications.md#answering-an-invitation`. The press is held rather
   * than dropped when an editor is open, because a banner button that does nothing is
   * the same class of failure as an alert that never fires.
   *
   * Every surface that answers an invitation lands here, so the holding, the fallback and
   * the drop from the outstanding pile cannot be honoured on one surface and missed on
   * another.
   */
  private async deliverRsvp(invite: PendingInvite, response: RsvpResponse): Promise<void> {
    const { key } = invite;
    const eid = extractEid(invite.event);
    const accountId = invite.sourceId.replace(/^google:/, '');
    if (!eid) {
      // Without an eid there is no way to address the chip, so fall back to showing the
      // user the event rather than pretending the answer was sent.
      log.warn(`Cannot drive RSVP for key ${key}: no resolvable eid; opening event link`);
      this.openDeepLink(buildEventLink(invite.event, accountId));
      return;
    }

    const outcome = await this.performRsvp(accountId, eid, response, invite.event.startTime, {
      endTime: invite.event.endTime,
      timezone: invite.event.timezone,
    });

    if (outcome === 'busy') {
      // The user is mid-edit, and answering would navigate out from under them. Hold the
      // intent rather than swallowing the press: a banner button that does nothing is the
      // same class of failure as an alert that never fires.
      log.info(`Holding RSVP ${response} on ${accountId} until editor closes`);
      this.holdAction({ key, accountId, eid, intent: response, startTime: invite.event.startTime });
      return;
    }

    if (outcome === 'failed') {
      // Google's own UI is the only way to answer; if driving it failed, put the event
      // in front of the user rather than dropping the response silently.
      log.warn(`could not answer ${response}; opening the event`);
      this.openDeepLink(buildEventLink(invite.event, accountId));
      return;
    }

    log.info(`RSVP ${response} on ${accountId} succeeded; resolving pending invitation`);
    this.invites.resolve(key);
    this.publishPending();
  }

  /**
   * Holds an RSVP the user pressed while an editor was open, and retries until it lands.
   *
   * Expires rather than queueing indefinitely: an intent that has sat for a quarter of an
   * hour no longer reliably reflects what the user meant, and firing it then would be a
   * surprise rather than a convenience.
   */
  private holdAction(item: HeldAction): void {
    // Keeps the first timestamp, so a press retried every five seconds still expires
    // fifteen minutes after it was made rather than never.
    const existing = this.heldActions.get(item.key);
    this.heldActions.set(item.key, { ...item, queuedAt: existing?.queuedAt ?? Date.now() });
    if (this.heldTimer) return;
    this.heldTimer = setInterval(() => void this.drainHeldActions(), HELD_RETRY_MS);
  }

  /** Runs a held action against whichever handler its intent belongs to. */
  private async runHeldAction(item: HeldAction): Promise<RsvpOutcome> {
    if (item.intent === 'delete') {
      return (
        (await this.performDelete?.(
          item.accountId,
          item.eid,
          item.startTime,
          item.isTask ?? false,
        )) ?? 'failed'
      );
    }
    if (item.intent === 'complete') {
      return (
        (await this.performComplete?.(
          item.accountId,
          item.eid,
          item.startTime,
          item.completed ?? true,
        )) ?? 'failed'
      );
    }
    return this.performRsvp(item.accountId, item.eid, item.intent, item.startTime);
  }

  private async drainHeldActions(): Promise<void> {
    for (const [key, item] of [...this.heldActions]) {
      if (Date.now() - item.queuedAt > HELD_EXPIRY_MS) {
        this.heldActions.delete(key);
        log.warn(`gave up on a held ${item.intent}; still editing after 15 minutes`);
        // A held delete took the event out of the popover the moment it was pressed.
        // Giving up has to put it back, or it stays gone from a calendar that still
        // has it.
        if (item.intent === 'delete') void this.pollNow();
        continue;
      }

      const outcome = await this.runHeldAction(item);

      if (outcome === 'busy') continue;

      this.heldActions.delete(key);
      log.info(`held ${item.intent} on ${item.accountId} ran once the editor closed: ${outcome}`);

      if (item.intent === 'delete') {
        void this.pollNow();
      } else if (item.intent === 'complete') {
        if (outcome === 'ok') {
          if (item.eventId) {
            const event = (this.cachedEvents.get(item.accountId) ?? []).find(
              (e) => e.id === item.eventId,
            );
            if (event) {
              this.applyLocalCompletion(item.accountId, event, item.completed ?? true);
              this.persistEventCache();
              this.onEventsUpdated?.(this.cachedEvents);
            }
          }
          void this.pollNow();
        }
      } else if (outcome === 'ok') {
        this.invites.resolve(key);
        this.publishPending();
      }
    }

    if (this.heldActions.size === 0 && this.heldTimer) {
      clearInterval(this.heldTimer);
      this.heldTimer = null;
    }
  }

  /**
   * Opens a conference URL, natively unless the user asked for the browser or has no
   * client installed.
   *
   * The single path both the banner and any later surface go through, so the preference
   * cannot end up honoured in one place and ignored in another.
   *
   * Asking macOS whether a client is installed is what keeps a Teams invitation from
   * reaching someone without Teams as a "no application is set to open the URL" dialog
   * and no meeting. The two ways of ending up in the browser stay separate, because a
   * user who turned the preference on is saying something different from a user who never
   * installed Zoom.
   */
  public async joinCall(conferenceUrl: string): Promise<void> {
    await openExternalUrl(conferenceUrl);
  }

  /**
   * Routes a `magical://` link to the right account's view.
   *
   * Reveals the event in place where it can — routing the document and clicking the
   * chip, so the detail panel opens over whichever view the user works in. Loading a URL
   * is for a link naming only a day; it reloads the view, so it is never used to recover
   * from a reveal that did not work.
   */
  public openDeepLink(rawUrl: string): boolean {
    const target = parseEventLink(rawUrl);
    if (!target) {
      // A link that parses to nothing does nothing, and silence here is indistinguishable
      // from the app having missed the link entirely.
      log.warn(`Ignoring a magical:// link that does not parse: ${redactUrl(rawUrl)}`);
      return false;
    }

    // Before the lookup: the accounts come from the window this may build.
    this.ensureWindowForLink?.(target.accountId);

    const account =
      this.getAccounts().find((a) => a.id === target.accountId) ?? this.getAccounts()[0];
    if (!account) {
      log.warn(`No account to follow a link for; wanted ${target.accountId}`);
      return false;
    }

    log.info(`Deep link ${target.action} on ${account.id}`);

    // Answering and deleting go through the same methods a banner button and a popover
    // row use, rather than calling the view driver underneath them. Those methods carry
    // the parts that are easy to lose: an invitation is dropped from the outstanding
    // pile once answered and held rather than dropped when an editor is open, and a
    // deleted event leaves the popover immediately instead of after the next poll.
    if (target.action !== 'reveal' && target.eid) {
      const { eid, action } = target;
      void this.actOnLinkedEvent(account.id, eid, action, target.date).then((outcome) =>
        log.info(`Deep link ${action} on ${account.id}: ${outcome}`),
      );
      return true;
    }

    // A link with no `at` names the event but not where it sits, which is what routing
    // to it needs. The cache usually knows, and asking it is what keeps such a link
    // working rather than dropping the user on today.
    const at =
      target.date ??
      (target.eid
        ? (this.cachedEvents.get(account.id) ?? []).find((e) => extractEid(e) === target.eid)
            ?.startTime
        : undefined);

    if (this.revealEvent && target.eid && at) {
      const { eid } = target;
      void this.revealEvent(account.id, eid, at).then((outcome) => {
        if (outcome === 'revealed') return;

        // Everything below is the link not working. Said out loud with the outcome
        // named, because from the outside they look identical -- the user pressed a
        // banner and the event did not open -- and the outcome is what says which of
        // the three it was.
        if (outcome === 'routed') {
          log.warn(
            `Deep link reached the day on ${account.id} but the event panel did not open (eid ${eid})`,
          );
          return;
        }

        // An editor is open, and following the link would discard it. The user asked to
        // go somewhere, so leave them where they are; pressing the banner again once
        // they are done does what they meant.
        if (outcome === 'busy') {
          log.info(`Deep link held: ${account.id} is mid-edit`);
          return;
        }

        // Deliberately no fallback navigation. The only URL that names an event is the
        // edit form, and dropping someone into an editor because a link failed is worse
        // than the link failing; the day view they are already on is not worth a reload.
        log.warn(
          `Deep link could not reach the event on ${account.id} (${decodeEid(eid)?.eventId ?? 'unresolved'})`,
        );
      });
      return true;
    }

    log.info(`Deep link has no event to reveal on ${account.id}; opening the day`);
    this.navigateAccount(account.id, resolveToCalendarUrl({ ...target, date: at }));
    return true;
  }

  // MARK: - Already-notified persistence

  private statePath(): string {
    const userData =
      typeof app?.getPath === 'function' ? app.getPath('userData') : '/tmp/magical-alerts';
    return path.join(userData, 'alert-state.json');
  }

  /**
   * Alerts already posted, so a restart does not replay the morning's meetings.
   *
   * Exactly the mistake Magimail made twice with its unread badge, and the one an alert
   * engine cannot get away with: a banner for a meeting that finished an hour ago is not
   * a stale count, it is a false alarm.
   */
  private loadState(): PersistedState {
    try {
      const parsed = readSecretFile<Partial<PersistedState>>(this.statePath()) ?? {};
      return {
        notified: Array.isArray(parsed.notified) ? parsed.notified : [],
        activeArrivals: Array.isArray(parsed.activeArrivals) ? parsed.activeArrivals : [],
      };
    } catch (err) {
      // Discarded rather than nursed back: an empty record risks repeating one banner,
      // and the next alert to fire rewrites the file.
      log.warn('could not read the alert record; starting from an empty one:', err);
      return { notified: [], activeArrivals: [] };
    }
  }

  private rememberNotified(key: string): void {
    this.notified.push(key);
    if (this.notified.length > MAX_REMEMBERED_ALERTS) {
      this.notified = this.notified.slice(-MAX_REMEMBERED_ALERTS);
    }
    this.persistState();
  }

  private rememberArrivals(keys: string[]): void {
    this.arrivals = keys;
    this.persistState();
  }

  private eventCachePath(): string {
    const userData =
      typeof app?.getPath === 'function' ? app.getPath('userData') : '/tmp/magical-alerts';
    return path.join(userData, 'event-cache.json');
  }

  /**
   * The last good read, so an outage does not start from nothing.
   *
   * A separate file from `alert-state.json` deliberately. That one is rewritten every
   * time a banner fires, and it is a few hundred keys; this one is written once a poll
   * and is three orders of magnitude bigger. Sharing a file would put a megabyte of
   * events on the path an alert takes.
   *
   * Alerts are re-armed from it on the next `schedule`, and the already-notified set
   * stops a restart replaying the morning's meetings, so seeding the cache cannot
   * resurrect an alert that has already fired.
   */
  private loadEventCache(): Map<string, NormalizedCalendarEvent[]> {
    const cache = new Map<string, NormalizedCalendarEvent[]>();
    try {
      const parsed = readSecretFile<Partial<PersistedEventCache>>(this.eventCachePath()) ?? {};
      let total = 0;
      for (const [accountId, events] of Object.entries(parsed.events ?? {})) {
        if (!Array.isArray(events)) continue;
        const revived = events
          .map((e) => this.reviveEvent(e))
          .filter((e): e is NormalizedCalendarEvent => e !== null);
        if (revived.length === 0) continue;
        cache.set(accountId, revived);
        total += revived.length;
      }
      if (total > 0) log.info(`Seeded ${total} event(s) from the last good read`);
    } catch (err) {
      // A cache that will not read is discarded rather than repaired: it is an
      // optimisation for this launch, and the next poll refills it.
      log.warn('could not read the event cache; the next poll refills it:', err);
    }
    return cache;
  }

  /**
   * Turns a stored event back into one the scheduler can use.
   *
   * Returns null rather than an event with a `NaN` time. A banner at the wrong hour is
   * worse than a missing one, and a file hand-edited or half-written is exactly where an
   * unusable timestamp comes from.
   */
  private reviveEvent(stored: PersistedEvent): NormalizedCalendarEvent | null {
    const startTime = new Date(stored.startTime);
    const endTime = new Date(stored.endTime);
    if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) return null;

    const { completedAt: storedCompletedAt, ...rest } = stored;
    let completedAt: Date | null | undefined;
    if (storedCompletedAt !== undefined) {
      completedAt = storedCompletedAt === null ? null : new Date(storedCompletedAt);
    }

    return {
      ...rest,
      created: stored.created === null ? null : new Date(stored.created),
      updated: stored.updated === null ? null : new Date(stored.updated),
      startTime,
      endTime,
      ...(completedAt !== undefined ? { completedAt } : {}),
    };
  }

  /**
   * The calendar day a moment falls on, keyed the way `loadedDays` stores days.
   *
   * Local midnight rather than a UTC division of the timestamp: the poll window begins
   * and ends at local midnight (`window()`), so a UTC day would straddle two calendar
   * days and let a request be answered from a day that was only partly read. The result
   * is rounded because a DST boundary moves midnight by an hour either way.
   */
  private dayKey(date: Date): number {
    const local = new Date(date.getTime());
    local.setHours(0, 0, 0, 0);
    return Math.round(local.getTime() / MS_PER_DAY);
  }

  /**
   * Records that a fetched range's calendar days are loaded, as of now.
   *
   * Day granularity rather than a range list: the window's trailing edge rolls
   * forward every poll, so a range merged across polls would keep inheriting
   * the newest timestamp and never age. A day that rolls out simply stops being
   * re-recorded and ages from the last poll that covered it.
   */
  private markRangeLoaded(accountId: string, range: { start: Date; end: Date }): void {
    let days = this.loadedDays.get(accountId);
    if (!days) {
      days = new Map();
      this.loadedDays.set(accountId, days);
    }
    const now = Date.now();
    const startMs = range.start.getTime();
    const endMs = range.end.getTime();
    const day = new Date(range.start);
    day.setHours(0, 0, 0, 0);
    while (day.getTime() <= endMs) {
      const next = new Date(day.getTime());
      next.setDate(next.getDate() + 1);
      // The fetched span, clamped to this local day, so a partial read is recorded as
      // partial and the rest of the day is fetched when a later request needs it.
      const from = Math.max(day.getTime(), startMs);
      const to = Math.min(next.getTime() - 1, endMs);
      if (from <= to) {
        const key = this.dayKey(day);
        const existing = days.get(key);
        if (existing) {
          existing.from = Math.min(existing.from, from);
          existing.to = Math.max(existing.to, to);
          existing.at = now;
        } else {
          days.set(key, { at: now, from, to });
        }
      }
      day.setDate(day.getDate() + 1);
    }
  }

  /**
   * Whether a loaded day still covers this event, so it is safe to keep.
   *
   * Judged on the event's instants, all-day and timed alike: the ledger records the ranges a
   * fetch read, so a day answers "was this range fetched" and not "which date is this event
   * on". An all-day event's date is a UTC date, but reading its ends through it would ask the
   * ledger about a day past the edge of what was fetched and drop an event the fetch did read.
   */
  private isCoveredByLoadedDay(accountId: string, event: NormalizedCalendarEvent): boolean {
    const days = this.loadedDays.get(accountId);
    // An account that has never been read has nothing to judge against, so its
    // cache is left alone rather than emptied.
    if (!days || days.size === 0) return true;
    const from = this.dayKey(event.startTime);
    const to = this.dayKey(event.endTime);
    // A year-long event is not worth walking day by day; the ends decide.
    if (to - from > 366) return days.has(from) || days.has(to);
    for (let day = from; day <= to; day++) {
      if (days.has(day)) return true;
    }
    return false;
  }

  /**
   * Drops cached events whose calendar days are no longer loaded.
   *
   * The days it judges against are only ever ones a fetch recorded, so it
   * never claims anything about dates that were never read; the worst a drop
   * costs is a re-fetch if the user pages back, which is what an unloaded month
   * already costs. Bounds a cache that otherwise grows with every month visited
   * and every day the window rolls past.
   */
  private pruneEventCache(): void {
    const now = Date.now();
    const retentionMs = LOADED_RETENTION_DAYS * MS_PER_DAY;
    for (const [accountId, days] of this.loadedDays) {
      for (const [day, loaded] of days) {
        if (now - loaded.at > retentionMs) days.delete(day);
      }
      const events = this.cachedEvents.get(accountId);
      if (!events) continue;
      const kept = events.filter((event) => this.isCoveredByLoadedDay(accountId, event));
      if (kept.length === events.length) continue;
      this.cachedEvents.set(accountId, kept);
      log.info(
        `Dropped ${events.length - kept.length} cached event(s) outside the loaded retention window for ${accountId}`,
      );
    }
  }

  private persistEventCache(): void {
    try {
      const now = Date.now();
      const from = now - CACHED_DAYS_PAST * 86_400_000;
      const to = now + CACHED_DAYS_AHEAD * 86_400_000;

      const events: Record<string, PersistedEvent[]> = {};
      let total = 0;
      for (const [accountId, cached] of this.cachedEvents) {
        const window = cached
          .filter((e) => e.endTime.getTime() >= from && e.startTime.getTime() <= to)
          .map((e) => ({
            ...e,
            created: e.created ? e.created.getTime() : null,
            updated: e.updated ? e.updated.getTime() : null,
            startTime: e.startTime.getTime(),
            endTime: e.endTime.getTime(),
            completedAt:
              e.completedAt instanceof Date
                ? e.completedAt.getTime()
                : (e.completedAt ?? undefined),
          }));
        if (window.length === 0) continue;
        events[accountId] = window;
        total += window.length;
      }

      fs.mkdirSync(path.dirname(this.eventCachePath()), { recursive: true });
      writeSecretFile(this.eventCachePath(), { events } satisfies PersistedEventCache);
      log.info(`Wrote ${total} event(s) to the cache`);
    } catch (err) {
      // The cache is an optimisation for the next launch, not something this one needs.
      log.warn('could not persist the event cache:', err);
    }
  }

  private persistState(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath()), { recursive: true });
      writeSecretFile(this.statePath(), {
        notified: this.notified,
        activeArrivals: this.arrivals,
      } satisfies PersistedState);
    } catch (err) {
      // Losing the record means a restart could repeat one banner; losing the alert
      // would be worse, so this never throws upward.
      log.warn('could not persist alert state:', err);
    }
  }
}

export { openExternalUrl, toNativeMeetingUrl } from './links.js';

export type { NormalizedCalendarEvent };
