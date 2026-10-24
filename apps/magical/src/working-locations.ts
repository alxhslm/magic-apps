/**
 * working-locations.ts
 *
 * Collapses a day's working locations down to the one Google would draw.
 */

import { allDayKey } from './all-day.js';
import { EVENT_TYPE, type NormalizedCalendarEvent } from './calendar-decoder.js';

/** Whether an entry says where the user is working, of either wire kind. */
export function isWorkingLocation(event: NormalizedCalendarEvent): boolean {
  return (
    event.eventType === EVENT_TYPE.WORKING_LOCATION ||
    event.eventType === EVENT_TYPE.WORKING_LOCATION_ONE_OFF
  );
}

/** The day an all-day entry falls on, as the wire states it: a date, with no zone. */
function dayKey(event: NormalizedCalendarEvent): string {
  return allDayKey(event.startTime);
}

/**
 * Whether the user set this location for the one day, rather than it coming from a series.
 *
 * `seriesId` is the honest signal. The wire's `eventType` tracks the same split today, but
 * it is a kind rather than a statement about recurrence, and reading it that way is what
 * made a named office set for a single day look like a location the user typed.
 */
function isOneOff(event: NormalizedCalendarEvent): boolean {
  return !event.seriesId && !event.recurrenceRule;
}

/** How recently Google last touched an entry, for picking between two of the same kind. */
function touchedAt(event: NormalizedCalendarEvent): number {
  return (event.updated ?? event.created)?.getTime() ?? 0;
}

/**
 * Leaves a day with the one working location Google would draw for it.
 *
 * A day has a regular working location, which a series sets for every Wednesday alike, and
 * the user overrides it a day at a time. The override does not cancel the regular entry:
 * Google serves both, carries no `EXDATE` on the series and does not tombstone the
 * occurrence, then draws only the override. Drawing both, as a faithful decode does, reads
 * as though the user were in two places at once.
 *
 * So the override wins, and between two overrides on one day the later one does, which is
 * the only ordering Google's payload offers.
 *
 * This is about the entry that states where the day is spent, which is the all-day one. A
 * working location given a time is an appointment like any other and Google draws it as
 * one; it needs nothing from here.
 */
export function collapseWorkingLocations(
  events: NormalizedCalendarEvent[],
): NormalizedCalendarEvent[] {
  const winners = new Map<string, NormalizedCalendarEvent>();

  for (const event of events) {
    if (!isWorkingLocation(event) || !event.isAllDay) continue;
    const key = dayKey(event);
    const held = winners.get(key);
    if (!held || beats(event, held)) winners.set(key, event);
  }

  if (winners.size === 0) return events;

  const kept = new Set([...winners.values()].map((e) => e.id));
  return events.filter(
    (event) => !isWorkingLocation(event) || !event.isAllDay || kept.has(event.id),
  );
}

/** Whether `candidate` is the entry to draw for the day, rather than `held`. */
function beats(candidate: NormalizedCalendarEvent, held: NormalizedCalendarEvent): boolean {
  if (isOneOff(candidate) !== isOneOff(held)) return isOneOff(candidate);
  return touchedAt(candidate) > touchedAt(held);
}
