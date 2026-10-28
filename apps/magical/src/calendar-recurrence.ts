import type { NormalizedCalendarEvent } from './calendar-decoder.js';

export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Reads an instant on the series' own clock.
 *
 * `toNaive` is the whole of it: it renders an instant as the wall clock the series is read in, so an
 * emitted occurrence's id is stamped the way the wire spells that occurrence. A timed event carries
 * its own IANA zone at `IDX.start[2]`; an all-day event is a date held in UTC, because the wire sends
 * it as midnight UTC and reading it through the machine's zone files it a day early west of UTC; and
 * a floating time with no zone follows the reader's machine.
 */
interface EventClock {
  /** This instant's wall-clock reading, relabelled as UTC. */
  toNaive(d: Date): Date;
}

const LOCAL_CLOCK: EventClock = {
  toNaive: (d) =>
    new Date(
      Date.UTC(
        d.getFullYear(),
        d.getMonth(),
        d.getDate(),
        d.getHours(),
        d.getMinutes(),
        d.getSeconds(),
      ),
    ),
};

const UTC_CLOCK: EventClock = {
  toNaive: (d) => d,
};

/**
 * The reader for a named IANA zone, through `Intl`, with one formatter cached per zone.
 *
 * The offset is read at an instant rather than assumed: `Intl` answers with the wall clock in
 * force in that zone at that instant, including whichever side of a DST transition it falls on.
 */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormatters.set(zone, formatter);
  }
  return formatter;
}

function zoneClock(zone: string): EventClock {
  const formatter = zoneFormatter(zone);
  const wallMs = (at: Date): number => {
    const fields: Record<string, number> = {};
    for (const part of formatter.formatToParts(at)) {
      if (part.type !== 'literal') fields[part.type] = Number(part.value);
    }
    return Date.UTC(
      fields.year,
      fields.month - 1,
      fields.day,
      fields.hour,
      fields.minute,
      fields.second,
    );
  };
  return {
    toNaive: (d) => new Date(wallMs(d)),
  };
}

function clockFor(event: NormalizedCalendarEvent): EventClock {
  if (event.isAllDay) return UTC_CLOCK;
  // A floating time has no zone of its own, so the machine is the only reader there is.
  if (!event.timezone) return LOCAL_CLOCK;
  try {
    return zoneClock(event.timezone);
  } catch {
    // A zone `Intl` rejects — a legacy Windows id, or a malformed one — leaves the event with no
    // reader of its own. Falling back to the machine's zone keeps the account readable; throwing
    // here would mark the whole account unreadable for one odd `IDX.start[2]`.
    return LOCAL_CLOCK;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

function toCompactIso(d: Date, clock: EventClock): string {
  const n = clock.toNaive(d);
  return (
    `${n.getUTCFullYear()}${pad(n.getUTCMonth() + 1)}${pad(n.getUTCDate())}` +
    `T${pad(n.getUTCHours())}${pad(n.getUTCMinutes())}${pad(n.getUTCSeconds())}`
  );
}

/**
 * How the wire names an occurrence it has materialised: the series id, then the slot the
 * occurrence came from, in UTC. `_20260918T084000Z` for a timed series and `_20260918` for an
 * all-day one. A moved occurrence keeps the stamp of the slot it came from, not the time it was
 * dragged to.
 */
const MATERIALISED_ID = /^(.+)_R?(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/;

/**
 * The `_R` recurrence spelling of an id, `<seriesId>_R<slotUTC>`.
 *
 * One copy of a split or edited series' anchor occurrence carries this id, and the same copy
 * carries the schedule for the new half of the series. Its own slot belongs to the schedule, so
 * when the slot is missing the occurrence was deleted even though the row is still live.
 */
const RECURRENCE_ANCHOR_ID = /_R\d{8}(?:T\d{6})?Z?$/;

/** The UTC slot an occurrence id names, or null when the id does not name one. */
function slotOfId(event: NormalizedCalendarEvent): number | null {
  const match = MATERIALISED_ID.exec(event.id);
  if (!match) return null;
  const [, , year, month, day, hour = '00', minute = '00', second = '00'] = match;
  return Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
}

/**
 * The events to show in `range`.
 *
 * A recurring series contributes the occurrences the wire materialised plus the starts its own
 * schedule lists that no materialised occurrence covers — never a rule walk, because a cancelled
 * occurrence is an omission from that schedule and a rule would put it back. Each emitted occurrence
 * takes its fields from the series' newest materialised instance, so a rename or an answer given
 * after the series was created is carried rather than the master's frozen copy. A removed master
 * record keeps the occurrences still returned under its id, and a cancelled one ends them. Events
 * entirely outside `range` are dropped.
 */
function seriesIdFor(event: NormalizedCalendarEvent): string {
  if (event.seriesId) return event.seriesId;
  const match = MATERIALISED_ID.exec(event.id);
  if (match) return match[1];
  return event.id;
}

export function expandRecurringEvents(
  events: NormalizedCalendarEvent[],
  range: DateRange,
): NormalizedCalendarEvent[] {
  const result: NormalizedCalendarEvent[] = [];
  // A recurring series arrives as the master, one materialised event per occurrence Google has
  // placed, and the series' own schedule. A cancelled occurrence is absent from that schedule, so
  // nothing has to be regenerated and no cancellation field has to be read. A tombstone for the
  // master's own id is a removed record rather than a cancellation, and keeps the occurrences still
  // returned under that id; see the first pass below.
  const cancelledSeries = new Set<string>();
  // Series whose master record the wire removed, which is not the same as cancelling the series:
  // the occurrences still returned under the id are the surviving half of a split.
  const removedMasterRecords = new Set<string>();
  //
  // The master is the series' first occurrence, frozen at the name and response it had then. A
  // series renamed or answered later carries the current state only on the occurrences Google
  // materialised after the change, so an emitted occurrence takes its shape from the newest
  // instance; the master would resurrect the old name and an unanswered response. See
  // `docs/magical/calendar-wire-format.md#stale-master`.
  //
  // To avoid single-instance overrides (e.g. one-off renames or RSVP declines) polluting
  // the series template for future occurrences, we keep all materialized instances per series.
  const instancesBySeries = new Map<string, NormalizedCalendarEvent[]>();
  // The occurrence starts the wire lists for a series; see `parseOccurrenceStarts`. Needed when a
  // split has removed the master record, leaving no rule to expand.
  const listedStartsBySeries = new Map<
    string,
    { starts: Date[]; template: NormalizedCalendarEvent }
  >();

  for (const event of events) {
    const seriesId = seriesIdFor(event);
    if (!event.isCancelled && event.occurrenceStarts && event.occurrenceStarts.length > 0) {
      const held = listedStartsBySeries.get(seriesId);
      if (held) held.starts.push(...event.occurrenceStarts);
      else
        listedStartsBySeries.set(seriesId, {
          starts: [...event.occurrenceStarts],
          template: event,
        });
    }
    if (event.isCancelled) {
      // A tombstone for the master's own id that carries no times means the series record was
      // removed, not that the series was cancelled. A "this and following" split does exactly
      // that: it deletes the old master and hands its occurrences to the replacement, which
      // keeps the id, and the wire goes on returning those occurrences live. Reading the record
      // removal as a cancellation dropped every one of them, so the moved-out half of a series
      // lost its whole future. A real cancellation names a slot, and so still ends the series.
      const masterRecordRemoved = event.id === seriesId && event.startTime.getTime() === 0;
      if (
        event.recurrenceRule ||
        event.id === seriesId ||
        (!event.seriesId && !MATERIALISED_ID.test(event.id))
      ) {
        cancelledSeries.add(seriesId);
        if (masterRecordRemoved) removedMasterRecords.add(seriesId);
      }
    } else if (!event.recurrenceRule) {
      const list = instancesBySeries.get(seriesId) ?? [];
      list.push(event);
      instancesBySeries.set(seriesId, list);
    }
  }

  const overlapsRange = (start: Date, end: Date) => end >= range.start && start <= range.end;

  for (const event of events) {
    if (event.isCancelled) continue;

    const seriesId = seriesIdFor(event);
    if (cancelledSeries.has(seriesId) || cancelledSeries.has(event.id)) {
      // A removed master's own id is gone, but an occurrence the wire still returns under it —
      // an id of its own, not the master's — is the surviving half of a "this and following"
      // split, and stays.
      const survivingOccurrence = removedMasterRecords.has(seriesId) && event.id !== seriesId;
      if (!survivingOccurrence) continue;
    }

    if (!event.recurrenceRule) {
      if (overlapsRange(event.startTime, event.endTime)) {
        // A deleted occurrence can still arrive as a live `_R` anchor row carrying the
        // schedule for the rest of the series. When its own slot is not in that schedule it
        // is the deleted occurrence, not an instance; the schedule's future starts are
        // emitted below, so only this row has to go.
        const listed = listedStartsBySeries.get(seriesId);
        const slot = RECURRENCE_ANCHOR_ID.test(event.id) ? slotOfId(event) : null;
        const anchorDelisted =
          listed && slot !== null && !listed.starts.some((start) => start.getTime() === slot);
        if (!anchorDelisted) {
          result.push(event.seriesId ? event : { ...event, seriesId });
        }
      }
      continue;
    }
    // A master carries the rule and no single occurrence of its own. Its occurrences are the
    // materialised instances pushed above and the series' own schedule emitted after this loop;
    // there is nothing here to expand.
  }

  // Emit the starts the series' own schedule lists that no materialised instance or tombstone
  // already covers. The schedule is the occurrence set: a rule would re-create the occurrences
  // Google cancelled, which the schedule leaves out.
  for (const [seriesId, { starts, template }] of listedStartsBySeries) {
    // A removed master record leaves its occurrences to the schedule, exactly as the instance pass
    // keeps them above; only a real cancellation ends the series.
    if (cancelledSeries.has(seriesId) && !removedMasterRecords.has(seriesId)) continue;
    const seriesInstances = instancesBySeries.get(seriesId) ?? [];
    const latestInstance = seriesInstances.length
      ? [...seriesInstances].sort((a, b) => a.startTime.getTime() - b.startTime.getTime())[
          seriesInstances.length - 1
        ]
      : undefined;
    const base = latestInstance ? { ...latestInstance } : template;
    const durationMs = Math.max(0, base.endTime.getTime() - base.startTime.getTime());
    const covered = new Set(
      result.filter((e) => seriesIdFor(e) === seriesId).map((e) => e.startTime.getTime()),
    );
    const clock = clockFor(base);

    for (const start of starts) {
      if (covered.has(start.getTime())) continue;
      const end = new Date(start.getTime() + durationMs);
      if (!overlapsRange(start, end)) continue;

      covered.add(start.getTime());
      const instanceId = `${seriesId}_R${toCompactIso(start, clock)}`;
      result.push({
        ...base,
        id: instanceId,
        seriesId,
        instanceId,
        startTime: start,
        endTime: end,
        recurrenceRule: undefined,
        recurrenceExceptions: undefined,
        occurrenceStarts: undefined,
      });
    }
  }

  // Deduplicate by id and slot, then sort chronologically. The slot is part of the key because
  // Google reuses an id: a contact's renamed birthday arrives as a live copy and a yearly master
  // under one id, and keying on the id alone dropped one of the two.
  const unique = new Map<string, NormalizedCalendarEvent>();
  for (const item of result) {
    unique.set(JSON.stringify([item.id, item.startTime.getTime()]), item);
  }

  return [...unique.values()].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}
