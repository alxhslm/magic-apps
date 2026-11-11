/**
 * The date range Google Calendar is showing, read from its rendered grid.
 *
 * The route alone is not enough. Calendar's month view can sit at `/r/month` with no
 * date, and the view it opens then is wherever the user was, not today. The grid always
 * renders its days as `data-datekey` cells, so the range is read from what is on screen
 * and the route is only a tie-breaker.
 */

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

/**
 * Decodes Calendar's `data-datekey`.
 *
 * The key is a packed date, not an epoch offset: `(year - 1970) << 9 | month << 5 | day`
 * with a 1-based month, which is why consecutive dates jump by two or three at a month
 * boundary. Reading it as days-since-epoch puts every date in 1950.
 */
export function decodeDateKey(raw: string | null | undefined): DateParts | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const key = Number(raw);
  if (!Number.isSafeInteger(key) || key < 0) return null;

  const year = (key >> 9) + 1970;
  const month = (key >> 5) & 0x0f;
  const day = key & 0x1f;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return { year, month, day };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The `YYYY-MM-DD` a date key names, or null when it is not a date. */
export function dateKeyToISO(raw: string | null | undefined): string | null {
  const parts = decodeDateKey(raw);
  if (!parts) return null;
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/**
 * The first day of the month Calendar is showing.
 *
 * Month view fills its leading and trailing weeks with days from the neighbouring
 * months, so the month with the most cells on screen is the one being displayed. Ties
 * break to the earliest month, which is what a six-week month with a single trailing
 * day needs.
 */
export function displayedMonthStart(dateKeys: Iterable<string | null | undefined>): string | null {
  const counts = new Map<string, number>();
  for (const raw of dateKeys) {
    const iso = dateKeyToISO(raw);
    if (!iso) continue;
    const month = iso.slice(0, 7);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }

  let best: string | null = null;
  let bestCount = 0;
  for (const [month, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && month < best)) {
      best = month;
      bestCount = count;
    }
  }

  return best ? `${best}-01` : null;
}

/** The earliest date Calendar has on screen, which is the start of a week or day range. */
export function visibleStartDate(dateKeys: Iterable<string | null | undefined>): string | null {
  let earliest: string | null = null;
  for (const raw of dateKeys) {
    const iso = dateKeyToISO(raw);
    if (!iso) continue;
    if (earliest === null || iso < earliest) earliest = iso;
  }
  return earliest;
}

/**
 * The views whose grid is laid out in weeks, so its earliest cell is the week's first day.
 *
 * Month belongs here because its earliest cell is the lead padding before the 1st. Day,
 * Year, Agenda and Schedule do not: a Day grid's earliest cell is the day itself, and Year
 * shows a whole year of months, so neither says anything about which day a week starts.
 */
const WEEK_BASED_TIMEFRAMES = new Set(['week', 'customweek', 'month']);

/**
 * The weekday Google Calendar is starting its weeks on, or null when the view cannot say.
 *
 * The earliest visible cell is the week's first day in Week and 4-Day view, and the lead
 * padding in Month view, so its weekday is Google's first weekday in both. This is the
 * only place it can be read: Google keeps Start of the week per account, defaults it to the
 * locale, and does not expose it through the API. Reading the grid is what makes the
 * sidebar's week unable to disagree with the calendar drawn beside it.
 *
 * Returned in Apple's `.weekday` numbering, 1 = Sunday through 7 = Saturday, because that
 * is what the helper's `Calendar.firstWeekday` takes.
 */
export function visibleWeekStartWeekday(
  timeframe: string,
  dateKeys: Iterable<string | null | undefined>,
): number | null {
  if (!WEEK_BASED_TIMEFRAMES.has(timeframe)) return null;
  const iso = visibleStartDate(dateKeys);
  if (!iso) return null;

  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return null;
  // UTC arithmetic on the parts, so the machine's zone cannot move the day across midnight.
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 1;
}

/**
 * The date the companion sidebar should anchor to.
 *
 * A route date wins when it falls in the month Calendar is showing, so clicking a day
 * inside the current month keeps that day selected. A stale or absent route date is
 * replaced by the grid: the sidebar follows the calendar on screen, never today.
 */
export function resolveAnchorDate(input: {
  timeframe: string;
  routeDateStr?: string | null;
  dateKeys: Iterable<string | null | undefined>;
  todayISO: string;
}): string {
  const { timeframe, routeDateStr, dateKeys, todayISO } = input;
  const keys = Array.from(dateKeys);

  if (timeframe === 'month') {
    const shownMonth = displayedMonthStart(keys);
    if (shownMonth) {
      const routeMonth = routeDateStr?.slice(0, 7);
      return routeMonth === shownMonth.slice(0, 7) ? routeDateStr! : shownMonth;
    }
  }

  if (routeDateStr) return routeDateStr;
  return visibleStartDate(keys) ?? todayISO;
}
