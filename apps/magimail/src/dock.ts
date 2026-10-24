import { app } from 'electron';
import { formatDockBadge } from '@magimail/core';
import { loadSettings } from './settings-store.js';

let currentBadgeCount = 0;
let currentArrivals: ArrivalBadgeState = { count: 0, incomplete: false };

/**
 * The new-arrivals count, and whether it may be short of the truth.
 *
 * `incomplete` rides along with the number because it is a property of the
 * response the number came from, not of the number itself — the same 12 is
 * exact from a complete feed and a floor from a cut-short one.
 */
export interface ArrivalBadgeState {
  count: number;
  incomplete: boolean;
}

/**
 * Repaints the dock badge from whichever count the current mode asks for.
 *
 * Both counts are held here rather than chosen at the call site, because the
 * two arrive from different places and at different times: the unread total is
 * blended from the sidebar observer and the feed, while arrivals come only from
 * the feed. Keeping both means flipping the mode repaints immediately instead
 * of waiting for whichever source happens to report next.
 */
function repaint(): void {
  if (process.platform !== 'darwin' || !app?.dock) return;

  const { dockBadgeMode } = loadSettings();
  if (dockBadgeMode === 'off') {
    app.dock.setBadge('');
  } else if (dockBadgeMode === 'newArrivals') {
    app.dock.setBadge(formatDockBadge(currentArrivals.count, currentArrivals.incomplete));
  } else {
    app.dock.setBadge(formatDockBadge(currentBadgeCount));
  }
}

/**
 * Updates macOS dock icon badge count
 */
export function updateDockBadge(count: number, arrivals?: ArrivalBadgeState): void {
  currentBadgeCount = Math.max(0, count);
  if (arrivals) {
    currentArrivals = { count: Math.max(0, arrivals.count), incomplete: arrivals.incomplete };
  }
  repaint();
}

/** Repaints without new counts — for a mode change, which moves no number. */
export function refreshDockBadge(): void {
  repaint();
}

/**
 * Returns currently tracked unread badge count
 */
export function getCurrentBadgeCount(): number {
  return currentBadgeCount;
}

/** Returns the currently tracked count of unhandled new arrivals. */
export function getCurrentArrivalCount(): number {
  return currentArrivals.count;
}
