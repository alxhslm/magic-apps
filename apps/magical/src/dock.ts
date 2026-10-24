import { app, powerMonitor } from 'electron';
import { loadAddon } from './native-addon.js';
import { ICON_SVG_TEMPLATE } from './icon-template.js';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('Dock');

export interface CalendarDateParts {
  day: number;
  month: string;
  dayOfWeek: string;
}

/**
 * Extracts standard localized English 3-letter month and day number.
 */
export function getCalendarDateParts(date: Date = new Date()): CalendarDateParts {
  return {
    day: date.getDate(),
    month: date.toLocaleString('en-US', { month: 'short' }).toUpperCase(),
    dayOfWeek: date.toLocaleString('en-US', { weekday: 'short' }).toUpperCase(),
  };
}

/**
 * Pure SVG template string substitution replacing dynamic text elements in icon.svg.
 */
export function renderDockIconSvg(
  svgTemplate: string = ICON_SVG_TEMPLATE,
  date: Date = new Date(),
): string {
  const { day, month } = getCalendarDateParts(date);
  return svgTemplate
    .replace(/(<text id="cal-month-text(-back)?"[^>]*>).*?(<\/text>)/g, `$1${month}$3`)
    .replace(/(<text id="cal-date-number"[^>]*>).*?(<\/text>)/, `$1${day}$2`);
}

/**
 * Updates the native dock tile with the branded SVG for the given date (defaults to today).
 */
export function updateDockDate(date: Date = new Date()): void {
  if (process.platform !== 'darwin') return;
  const { day, month, dayOfWeek } = getCalendarDateParts(date);
  const svg = renderDockIconSvg(ICON_SVG_TEMPLATE, date);
  try {
    const addon = loadAddon();
    if (addon.updateDockDate) {
      addon.updateDockDate(day, month, dayOfWeek);
    } else if (addon.updateDockSvg) {
      addon.updateDockSvg(svg);
    }
  } catch (err) {
    log.warn('Native dock date update unavailable:', err);
  }
}

/**
 * Calculates milliseconds remaining until 00:00:00.050 tomorrow.
 */
export function msUntilNextMidnight(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 50);
  return Math.max(1000, next.getTime() - now.getTime());
}

/**
 * Schedules an exact timer to trigger at midnight and recur every midnight thereafter.
 */
export function scheduleMidnightRollover(
  onRollover: () => void,
  now: Date = new Date(),
): () => void {
  let timer: NodeJS.Timeout | null = null;
  let cancelled = false;

  const scheduleNext = () => {
    if (cancelled) return;
    const ms = msUntilNextMidnight();
    timer = setTimeout(() => {
      onRollover();
      scheduleNext();
    }, ms);
    if (timer.unref) timer.unref();
  };

  const initialMs = msUntilNextMidnight(now);
  timer = setTimeout(() => {
    onRollover();
    scheduleNext();
  }, initialMs);
  if (timer.unref) timer.unref();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Formats RSVP badge count. Returns null when 0 (badge cleared).
 */
export function formatRsvpBadge(count: number): string | null {
  if (count <= 0) return null;
  if (count > 99) return '99+';
  return String(count);
}

/**
 * Updates the macOS dock badge, strictly for invitations requiring action.
 *
 * The count is passed in rather than derived here. `InviteWatcher` owns it, because it is
 * the only thing that knows which invitations are still outstanding across accounts, and a
 * second place computing the same number is how a badge starts disagreeing with itself.
 */
export function updateDockBadge(count: number): void {
  if (process.platform !== 'darwin') return;

  const label = formatRsvpBadge(Math.max(0, count));
  try {
    const addon = loadAddon();
    if (addon.setDockBadge) {
      addon.setDockBadge(label);
      return;
    }
  } catch {
    // Fall back to Electron dock API
  }

  if (app?.dock) {
    app.dock.setBadge(label ?? '');
  }
}

/**
 * Initializes the dynamic dock tile, schedules midnight auto-rollover,
 * and attaches system wake listeners to handle sleep past midnight.
 */
export function initDock(powerMonitorRef?: typeof powerMonitor): () => void {
  if (process.platform !== 'darwin' && !powerMonitorRef) return () => {};

  updateDockDate();

  const cancelRollover = scheduleMidnightRollover(() => {
    updateDockDate();
  });

  const onResume = () => {
    updateDockDate();
  };

  const pm = powerMonitorRef ?? powerMonitor;
  pm?.on('resume', onResume);
  pm?.on('speed-limit-change', onResume);

  return () => {
    cancelRollover();
    pm?.removeListener('resume', onResume);
    pm?.removeListener('speed-limit-change', onResume);
  };
}
