/**
 * Which of Calendar's two full-page modes an account's view is in.
 *
 * Calendar and Tasks are different documents in Google's single-page app: the grid's
 * actions are absent in Tasks and vice versa, so anything that drives a control has to
 * know which one is on screen before it looks for it.
 */
export type ViewMode = 'calendar' | 'tasks';

/**
 * The `/calendar/u/<n>/r` a path is rooted at.
 *
 * One account per partition means `<n>` is almost always `0`, but it is read rather than
 * assumed: signing a second Google account into the same partition moves the view to
 * `u/1`, and a route rebuilt at `u/0` would then land on somebody else's calendar.
 */
export function calendarRoot(currentPath: string | null): string {
  return /^\/calendar\/u\/\d+\/r\b/.exec(currentPath ?? '')?.[0] ?? '/calendar/u/0/r';
}

/**
 * The path part of a view's URL.
 *
 * Compared whole rather than with `includes`, because Calendar's day paths nest as
 * prefixes: `/r/day/2026/9/1` is a substring of `/r/day/2026/9/19`, so a containment
 * test reports arrival at the first day while the view is still showing the nineteenth.
 */
export function pathnameOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/**
 * The mode a path names, from the path alone.
 *
 * Full-screen Tasks is `/calendar/u/<n>/r/tasks`. Bounded on the trailing `/` so a view
 * Google might one day call `/r/tasksomething` is read as a Calendar route rather than
 * mistaken for Tasks and driven as though it had a task list.
 */
export function viewModeForPath(path: string | null): ViewMode {
  return /\/r\/tasks(?:\/|$)/.test(path ?? '') ? 'tasks' : 'calendar';
}
