/**
 * all-day.ts
 *
 * The date an all-day event is on.
 * The wire sends an all-day entry as a bare epoch at midnight UTC, whatever the calendar's own zone —
 * a birthday, a bank holiday and a working location alike — while a timed event carries an IANA zone
 * beside its epoch. So an all-day date is that instant's **UTC** fields: read through the machine's
 * zone and it files a day early west of UTC. A timed event is an instant and stays on the machine's
 * clock. The helpers below hand the date back as a `YYYY-MM-DD` key or as a `Date` the machine's own
 * formatters read as that date.
 */

/** A calendar date, with no zone and no time of day. */
interface CalendarDate {
  year: number;
  /** 1-based, as a calendar states the month. */
  month: number;
  day: number;
}

/** The calendar date an all-day instant is on: its UTC fields, never the machine's. */
function allDayDate(instant: Date): CalendarDate {
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
  };
}

/**
 * A `Date` the machine's own formatters read as an all-day event's date.
 *
 * Built from the instant's UTC fields rather than from the instant, so the machine's zone
 * decides only how the date is spelled, never which date it is.
 */
export function allDayLocalDate(instant: Date): Date {
  const { year, month, day } = allDayDate(instant);
  return new Date(year, month - 1, day);
}

/** `YYYY-MM-DD`, the key a grid cell and a working-location day are filed under. */
export function allDayKey(instant: Date): string {
  const { year, month, day } = allDayDate(instant);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The last instant an all-day span covers.
 *
 * The end is exclusive, at midnight UTC on the morning after, so a one-day event ends on
 * the next date; stepping back a millisecond lands on the last date the event covers.
 */
export function allDayLastInstant(start: Date, end: Date): Date {
  return new Date(Math.max(start.getTime(), end.getTime() - 1));
}
