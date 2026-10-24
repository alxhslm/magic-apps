import type { BaseWindow } from 'electron';

/**
 * Which path runs an action when the main window may be closed.
 *
 * `Outcome` is the app's own union: Magimail's is `ok | failed`, Magical's adds `busy` for an
 * action an open editor is holding. `failed` is the one value both unions share, and the only
 * outcome this module names: it is the verdict that sends the action to a page.
 */
export interface WindowRoute<Outcome extends string> {
  /** The window's own stack, while its window is open. Null when it is closed. */
  window: () => Promise<Outcome> | null;

  /** The direct write. Built whether or not a window is open. */
  direct: () => Promise<Outcome>;

  /** Builds the window and runs the action through it. Reached only when the write cannot. */
  openWindow: () => Promise<Outcome>;
}

/** Runs the direct write, and builds a window for the page only when that cannot finish the job. */
export async function routeAcrossWindow<Outcome extends string>(
  route: WindowRoute<Outcome>,
): Promise<Outcome> {
  const viaWindow = route.window();
  if (viaWindow) return viaWindow;

  const outcome = await route.direct();
  if (outcome !== 'failed') return outcome;

  return route.openWindow();
}

/** Where an action's window comes from, as the app holds it. */
export interface WindowActionTarget<Manager> {
  /** The window, while one is open. */
  getWindow: () => BaseWindow | null;

  /** Builds the window and stores it in whatever handle the app keeps it in. */
  createWindow: (accountId: string | undefined, options: { show: boolean }) => void;

  /** Brings the app forward, so the window it raises lands on top. */
  focusApp: () => void;

  /** The manager the window built, or null while there is none. */
  getManager: () => Manager | null;
}

/**
 * Brings the main window up for an entry point that arrived without one.
 *
 * The account is handed to the window's own creation so the view that loads is the one the action
 * is about. `show: false` builds it in the background instead: an action that drives a page must
 * not raise a window, and one that asks to look at something raises it itself. Returns the manager
 * the window built, or null when there is still none.
 */
export function openWindowForAction<Manager>(
  target: WindowActionTarget<Manager>,
  accountId?: string,
  options: { show?: boolean } = {},
): Manager | null {
  const win = target.getWindow();
  if (!win) {
    target.createWindow(accountId, { show: options.show ?? true });
  } else if (options.show ?? true) {
    target.focusApp();
    win.show();
    win.focus();
  }
  return target.getManager();
}
