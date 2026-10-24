import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, redactText } from '@magimail/core/logger';
import { allDayLastInstant, allDayLocalDate } from './all-day.js';
import { conferenceLabel } from './notification-manager.js';
import { toNativeMeetingUrl } from './calendar-service.js';
import type { SerializedTrayAccount, SerializedTrayEvent } from './menubar-manager.js';
import { uiString } from './strings.js';
import type { SerializedTrayCalendar } from './calendars.js';
import type { CalendarRef } from './settings-store.js';

const log = createLogger('WidgetCache');

/**
 * Snapshot the WidgetKit extension reads to render its timeline.
 *
 * Lives in the App Group container both sides are entitled for, so the
 * extension needs no access to Application Support, where the Google session
 * cookies also live. Resolving the path goes through the native addon because
 * only `containerURL(forSecurityApplicationGroupIdentifier:)` makes
 * `containermanagerd` create a directory the sandboxed extension can open.
 */
export interface WidgetCache {
  updatedAt: number;
  events: WidgetCacheEvent[];
  /** Calendars with something on that day, keyed `YYYY-MM-DD`, for the grid. */
  densityDots: Record<string, WidgetCacheDot[]>;
  /**
   * Every calendar the accounts hold, which is what each widget's own picker offers.
   *
   * Carried in the snapshot because the picker runs in the extension, and the extension
   * can read this file and nothing else of Magical's.
   */
  calendars: WidgetCacheCalendar[];
  /**
   * The menu bar popover's filter, which a widget nobody has configured follows.
   *
   * A widget with its own choice ignores this; see `CalendarSelectionIntent` in
   * `widgets/Sources/CalendarFilter.swift`.
   */
  hiddenCalendars: CalendarRef[];
  /**
   * Which account a day cell in the grid opens.
   *
   * A day belongs to no account, but `magical://date` needs one, so the grid
   * uses whichever account the app is showing.
   */
  activeAccountId?: string;
  /** Whether a macOS Focus filter is active in Magical. */
  isFocusActive?: boolean;
  /**
   * Calendars silenced by the active Focus filter.
   *
   * The extension composes these with each widget's own chosen calendars.
   */
  silencedCalendars?: CalendarRef[];
}

/** One calendar in a widget's picker, named by account as well as by calendar. */
export interface WidgetCacheCalendar extends CalendarRef {
  /**
   * How the account is named in the picker: its address where it has one, because two
   * accounts commonly carry the same display name and both hold a Birthdays.
   */
  accountName: string;
  name: string;
  colorHex: string;
}

/** One calendar with something on a given day, which the grid draws as a dot. */
export interface WidgetCacheDot extends CalendarRef {
  colorHex: string;
}

export interface WidgetCacheEvent {
  id: string;
  /** Which account holds the event, since a calendar id alone does not name a calendar. */
  accountId: string;
  /** Every calendar of the account's that holds it, canonicalised as the popover has it. */
  calendarIds: string[];
  title: string;
  /** Milliseconds since the epoch. */
  start: number;
  end: number;
  isAllDay: boolean;
  /** What kind of entry this is, so a widget can draw a birthday or a task as one. */
  eventType: number;
  /** Whether this task has been completed. */
  isCompleted?: boolean;
  /** The calendar's colour, resolved by `menubar-manager.ts`. */
  colorHex: string;
  /**
   * Already converted for the desktop client. The Join intent runs in the
   * extension's sandbox and cannot reach `toNativeMeetingUrl`, so it opens
   * whatever this field holds.
   */
  joinUrl?: string;
  /** Worded as the banner and the popover word it; a meeting must not read two ways. */
  conferenceService?: string;
  /**
   * Reveals the event, falling back to its day.
   *
   * `buildEventLink` picks between the two: an event Google gave an `eid` for
   * is addressed directly, and anything else lands on the day it is on, which
   * is where the popover sends a link it cannot resolve either.
   */
  openUrl?: string;
}

const CACHE_FILE = 'widget-cache.json';

/** How many days of events to carry. Agenda at large shows three. */
export const CACHE_DAYS = 3;

/**
 * Calendars one day may carry a dot for.
 *
 * Well above the four dots a day cell draws, because a widget takes its own hidden
 * calendars out afterwards: cap at four here and a day whose first four calendars are all
 * hidden would lose the dots it should still show.
 */
const MAX_DOT_CALENDARS_PER_DAY = 12;

/** How many days one event may mark. Two months is more grid than anyone scrolls. */
const MAX_SPAN_DAYS = 62;

/** Resolved once: the container is created on first call, not on every poll. */
let groupContainer: string | null | undefined;

/**
 * Where the extension reads the cache from, or null when this build cannot
 * claim the group. Warns once, on the call that resolves it.
 *
 * Injectable so the resolution rule can be tested without the native addon.
 */
export function widgetCachePath(resolveGroupContainer?: () => string | null): string | null {
  if (groupContainer === undefined) {
    try {
      groupContainer = resolveGroupContainer ? resolveGroupContainer() : null;
    } catch (error) {
      groupContainer = null;
      log.error('Resolving the App Group container failed', error);
    }
    if (groupContainer === null) {
      log.warn('No App Group container for this build; the widget renders its placeholder');
    }
  }
  return groupContainer ? path.join(groupContainer, CACHE_FILE) : null;
}

/** Forgets the resolved container. Tests only. */
export function resetWidgetCachePath(): void {
  groupContainer = undefined;
}

/**
 * The day an event is filed under, in the local zone.
 *
 * Local rather than UTC because a 23:00 meeting belongs to the evening the user
 * is having, and `toISOString` would file it under tomorrow for anyone east of
 * Greenwich.
 */
export function dayKey(timestamp: number): string {
  const d = new Date(timestamp);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * `magical://date?account=…&at=…`, the shape `parseEventLink` answers.
 *
 * An all-day entry carries the date it is on as a local midnight, because the reader
 * (`AccountsManager.pathForDate`) names the day with local getters; the raw UTC midnight
 * instant would open the day before west of UTC.
 */
function dayLink(event: SerializedTrayEvent): string {
  const start = event.isAllDay
    ? allDayLocalDate(new Date(event.startTime))
    : new Date(event.startTime);
  return `magical://date?account=${encodeURIComponent(event.accountId)}&at=${encodeURIComponent(start.toISOString())}`;
}

function startOfDay(timestamp: number): number {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** What the menu bar has to hand when it writes the snapshot. */
export interface WidgetCacheInput {
  events: SerializedTrayEvent[];
  /** Every calendar the accounts hold, for each widget's picker. */
  calendars: SerializedTrayCalendar[];
  /** Who holds them, so the picker can say which account a calendar is on. */
  accounts: SerializedTrayAccount[];
  /** The popover's filter, which an unconfigured widget follows. */
  hiddenCalendars: CalendarRef[];
  activeAccountId?: string;
  isFocusActive?: boolean;
  silencedCalendars?: CalendarRef[];
  now?: number;
}

/**
 * Build the snapshot from what the menu bar already has.
 *
 * Nothing is filtered here. Each widget carries its own choice of calendars in its
 * configuration, which only the extension can read, so the snapshot has to hold every
 * event and let the extension decide; see `CalendarFilter.swift`. Focus state is passed
 * alongside so the extension can compose it with the widget's chosen calendars.
 */
export function buildWidgetCache(input: WidgetCacheInput): WidgetCache {
  const {
    events,
    calendars,
    accounts,
    hiddenCalendars,
    activeAccountId,
    isFocusActive,
    silencedCalendars,
  } = input;
  const accountNames = new Map(accounts.map((a) => [a.id, a.email || a.name]));
  const now = input.now ?? Date.now();
  const horizon = startOfDay(now) + CACHE_DAYS * 24 * 60 * 60 * 1000;

  const carried = events
    .filter((event) => event.endTime >= startOfDay(now) && event.startTime < horizon)
    .sort((a, b) => a.startTime - b.startTime)
    .map((event): WidgetCacheEvent => {
      const joinUrl = event.conferenceUrl ? toNativeMeetingUrl(event.conferenceUrl) : undefined;
      return {
        id: event.id,
        accountId: event.accountId,
        calendarIds: event.calendarIds,
        title: event.summary || uiString('notification.noTitle'),
        start: event.startTime,
        end: event.endTime,
        isAllDay: event.isAllDay,
        eventType: event.eventType,
        isCompleted: event.isCompleted,
        colorHex: event.colorHex,
        ...(joinUrl ? { joinUrl } : {}),
        ...(event.conferenceUrl ? { conferenceService: conferenceLabel(event.conferenceUrl) } : {}),
        openUrl: event.deepLink ?? dayLink(event),
      };
    });

  return {
    updatedAt: now,
    events: carried,
    densityDots: buildDensityDots(events),
    calendars: calendars.map((calendar) => ({
      accountId: calendar.accountId,
      calendarId: calendar.id,
      accountName: accountNames.get(calendar.accountId) ?? calendar.accountId,
      name: calendar.name,
      colorHex: calendar.colorHex,
    })),
    hiddenCalendars: hiddenCalendars.map(({ accountId, calendarId }) => ({
      accountId,
      calendarId,
    })),
    ...(activeAccountId ? { activeAccountId } : {}),
    ...(isFocusActive !== undefined ? { isFocusActive } : {}),
    ...(silencedCalendars !== undefined ? { silencedCalendars } : {}),
  };
}

/**
 * One dot per calendar with something on that day.
 *
 * Per calendar rather than per colour, because the extension has still to take out the
 * calendars its widget does not show, and a bare colour cannot be matched against a
 * filter. Colours are collapsed when the grid draws them.
 *
 * Every event is counted, not just the three days the agenda carries: the grid
 * spans the month, and a day with no dot has to mean the day is empty rather
 * than out of range.
 *
 * An event marks every day it covers, not just the day it starts. A holiday
 * from Thursday to Tuesday left the intervening days blank, so the grid said
 * nothing was on during a week that was entirely booked.
 *
 * An event on several calendars marks the day once for each, so hiding one of them
 * leaves the day dotted through the others, which is the rule the events themselves
 * follow.
 */
function buildDensityDots(events: SerializedTrayEvent[]): Record<string, WidgetCacheDot[]> {
  const byDay = new Map<string, WidgetCacheDot[]>();

  for (const event of events) {
    for (const key of daysCovered(event)) {
      const dots = byDay.get(key) ?? [];
      for (const calendarId of event.calendarIds) {
        const already = dots.some(
          (dot) => dot.accountId === event.accountId && dot.calendarId === calendarId,
        );
        if (!already && dots.length < MAX_DOT_CALENDARS_PER_DAY) {
          dots.push({ accountId: event.accountId, calendarId, colorHex: event.colorHex });
        }
      }
      byDay.set(key, dots);
    }
  }

  return Object.fromEntries(byDay);
}

/**
 * Every day key an event touches, from its first to its last.
 *
 * An all-day entry is a date, so its ends are read from their UTC fields and the dot lands
 * on the cell the event is on rather than the machine's day before it west of UTC; a timed
 * entry is an instant and keeps the machine's day, which is the evening the user is having.
 * Either way the end is exclusive, at midnight on the morning after, so the last covered
 * moment is the end stepped back by one millisecond; otherwise a one-day holiday would dot
 * two days. Capped so that a subscription with a year-long entry on it cannot fill the
 * snapshot with keys nobody will scroll to.
 */
function daysCovered(event: SerializedTrayEvent): string[] {
  const firstDate = event.isAllDay
    ? allDayLocalDate(new Date(event.startTime))
    : new Date(event.startTime);
  const lastDate = event.isAllDay
    ? allDayLocalDate(allDayLastInstant(new Date(event.startTime), new Date(event.endTime)))
    : new Date(event.endTime - 1);
  const last = startOfDay(Math.max(firstDate.getTime(), lastDate.getTime()));
  const keys: string[] = [];

  for (
    let day = startOfDay(firstDate.getTime());
    day <= last && keys.length < MAX_SPAN_DAYS;
    day = startOfDay(day + 36 * 60 * 60 * 1000)
  ) {
    keys.push(dayKey(day));
  }

  return keys;
}

/** The part a widget draws. `updatedAt` moves every poll and changes nothing on screen. */
function contentKey(cache: WidgetCache): string {
  return JSON.stringify({
    events: cache.events,
    densityDots: cache.densityDots,
    isFocusActive: cache.isFocusActive,
    silencedCalendars: cache.silencedCalendars,
  });
}

let lastWritten: string | undefined;

/** Forgets what was last written. Tests only. */
export function resetWidgetCacheContent(): void {
  lastWritten = undefined;
}

/**
 * Write the cache where the extension reads it, and say whether anything
 * changed. Does nothing when there is no container to write into.
 *
 * **Returns true only when the snapshot differs from the last one written**, so
 * the caller can reload the timelines on a changed meeting rather than on every
 * poll. WidgetKit throttles an extension that asks too often, and the poller
 * runs every five minutes on mains whether or not the diary moved.
 *
 * Writes via a temporary file and renames, so the extension never observes a
 * half-written JSON document. Reloading the timelines is the caller's job; see
 * `reloadNativeWidgets`.
 */
export function writeWidgetCache(
  cache: WidgetCache,
  resolveGroupContainer?: () => string | null,
): boolean {
  const target = widgetCachePath(resolveGroupContainer);
  if (!target) return false;

  const key = contentKey(cache);
  if (key === lastWritten) return false;

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(cache), 'utf8');
    fs.renameSync(temp, target);
    lastWritten = key;
    return true;
  } catch (error) {
    log.error('Failed to write cache to', redactText(target), error);
    return false;
  }
}
