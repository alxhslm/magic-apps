/**
 * time-format.ts
 *
 * The clock the user reads, for every string this process builds.
 *
 * The Mac's region and its 12/24-hour switch are separate settings: the switch writes
 * `AppleICUForce24HourTime` and leaves the region alone, so an `en_GB` Mac can be forced to
 * a 12-hour clock and an `en_US` Mac to a 24-hour one. `toLocaleTimeString(undefined, …)`
 * sees neither, because in Electron's main process `undefined` resolves to ICU's default
 * locale rather than macOS's. So the cycle is resolved once, at startup, from the Mac, and
 * every user-visible time goes through the formatters here.
 *
 * Fixed patterns such as `HH:mm` or `hourCycle: 'h23'` belong to sort keys and log
 * timestamps, never to something on screen.
 */

export type HourCycle = 'h12' | 'h23';

interface Clock {
  locale: string;
  hourCycle: HourCycle;
}

let clock: Clock | undefined;

/**
 * Resolves the cycle from the Mac's own switch, falling back to what the locale says when
 * the switch has never been touched.
 *
 * Only a definite `true` or `false` is authoritative. macOS writes the key when the user
 * changes the switch and leaves it absent otherwise, and an absent key must not be read as
 * "12-hour": that is the bug this module exists to avoid.
 */
export function resolveHourCycle(locale: string, forced24Hour?: boolean): HourCycle {
  if (forced24Hour !== undefined) return forced24Hour ? 'h23' : 'h12';

  const resolved = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
  return resolved === 'h11' || resolved === 'h12' ? 'h12' : 'h23';
}

/** Records the system clock. Called once from `app.whenReady()`. */
export function setClock(locale: string, forced24Hour?: boolean): void {
  clock = { locale, hourCycle: resolveHourCycle(locale, forced24Hour) };
}

/** Replaces the clock for one test, so a formatter can be exercised in both cycles. */
export function setClockForTests(locale: string, hourCycle: HourCycle): void {
  clock = { locale, hourCycle };
}

function currentClock(): Clock {
  if (!clock) {
    // Anything built before `whenReady` still has to render a time rather than throw, and
    // the locale's own cycle is the right answer when the switch is unknown.
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    clock = { locale, hourCycle: resolveHourCycle(locale) };
  }
  return clock;
}

/**
 * A date or time in the Mac's locale and hour cycle.
 *
 * An `hourCycle` without an `hour` field is ignored by `Intl`, so the same call serves an
 * all-day date that has no clock on it.
 */
export function formatClock(date: Date, options: Intl.DateTimeFormatOptions = {}): string {
  const { locale, hourCycle } = currentClock();
  return date.toLocaleString(locale, { ...options, hourCycle });
}

/** A time of day alone, for an alert subtitle. */
export function formatTime(date: Date): string {
  return formatClock(date, { hour: '2-digit', minute: '2-digit' });
}
