import type { NormalizedCalendarEvent } from './calendar-decoder.js';

/**
 * A canary for the agenda drawing one meeting twice.
 *
 * The recurrence path is subtle — a series arrives as a master plus materialised
 * occurrences, an edited series sends one occurrence under two ids, and the expander fills
 * the slots Google left out — and each way of getting it wrong shows up the same way on
 * screen: one meeting counted twice, its alert armed twice, the badge two too high. Rather
 * than trust the tests to have imagined every wire shape, `CalendarService` scans the
 * merged agenda and logs any pair that names one meeting, so a payload nobody predicted is
 * caught in the field instead of by a user seeing a double.
 *
 * Two entries are one meeting when they agree on the event's `uid` and on its start. `uid`
 * names the event and every occurrence of a series shares it; the start names the
 * occurrence. A **moved** occurrence's two copies disagree on the start, so this key would
 * not group them; the decoder's `occurrenceKey` folding is what keeps them to one event,
 * and its tests cover that. Events with no `uid` — a one-off, an import — fall back to
 * `seriesId`, then to their id, so two unrelated meetings are never grouped.
 *
 * The title is deliberately not part of the key: three candidates can share one interview
 * slot and title, and they are three meetings, not one.
 */
export function duplicateMeetingKey(event: NormalizedCalendarEvent): string {
  return `${event.uid ?? event.seriesId ?? event.id}\u0000${event.startTime.getTime()}`;
}

export interface DuplicateMeeting {
  key: string;
  events: NormalizedCalendarEvent[];
}

/**
 * The one line the canary writes for a meeting it saw twice.
 *
 * Account, count and start only. The title is the user's own data and the ids map to it,
 * and `main.log` is the file a bug report attaches, so neither belongs here.
 */
export function duplicateMeetingWarning(
  accountId: string,
  group: NormalizedCalendarEvent[],
): string {
  return `duplicate meeting on ${accountId}: ${group.length} entries at ${group[0].startTime.toISOString()}`;
}

/** Every meeting the list holds more than once, with the entries that name it. */
export function findDuplicateMeetings(events: NormalizedCalendarEvent[]): DuplicateMeeting[] {
  const groups = new Map<string, NormalizedCalendarEvent[]>();
  for (const event of events) {
    const key = duplicateMeetingKey(event);
    const held = groups.get(key);
    if (held) held.push(event);
    else groups.set(key, [event]);
  }

  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({ key, events: group }));
}
