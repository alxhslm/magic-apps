/**
 * What a reload request should tear down to recover a window that has stopped
 * presenting.
 *
 * Rebuilding the account view is the cheap path, and it is what fixes a view whose
 * own compositor has died: the view is closed and a fresh one attaches to the same
 * window.
 *
 * It cannot fix the window. The log from 29 October records twenty rebuilds in
 * twenty seconds, each detaching, creating, attaching and navigating, with the
 * window still blank afterwards; the page kept answering DOM actions throughout.
 * The only recovery seen for that state is a new window, so a second request close
 * behind the first rebuilds the window instead of the view.
 */
export type ReloadRecovery = 'view' | 'window';

/** How soon after a view rebuild a further request is taken as proof it did not work. */
export const RECREATE_WINDOW_WITHIN_MS = 60_000;

/**
 * Picks the recovery for a reload request.
 *
 * `lastRequestAt` is when the previous request was served, or undefined when this is
 * the first one this window has seen.
 */
export function chooseReloadRecovery(
  lastRequestAt: number | undefined,
  now: number,
): ReloadRecovery {
  if (lastRequestAt === undefined) return 'view';
  return now - lastRequestAt < RECREATE_WINDOW_WITHIN_MS ? 'window' : 'view';
}
