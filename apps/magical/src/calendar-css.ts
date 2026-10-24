import { labelSelectors } from '@magimail/core';
import { domAction, domSelector } from './dom-labels.js';

/**
 * CSS injected into the Google Calendar view at `did-navigate`, before first
 * paint. Selectors are ARIA-only: Google Calendar's class names are minified and
 * rotate without notice, and a stale one here fails silently as a flash of
 * unstyled Google chrome.
 *
 * Where a control has no strong hook the clause is built from the locale action map
 * through `labelSelectors`, so it carries a `:lang()` scope and matches only a page
 * in the language the label is written for. A non-English account is left as Google
 * renders it rather than styled as though it were English.
 *
 * Dark mode is deliberately absent. Google Calendar honours
 * `prefers-color-scheme` when its own Appearance setting is left on "Device",
 * and Electron drives that from `nativeTheme.themeSource` — so syncing the theme
 * is a main-process concern, not an injected one. Filtering the page the way
 * Magimail has to filter Gmail would fight Google's own dark palette.
 */

/**
 * The `:lang()`-scoped attribute fragments for a label action, joined for an
 * `:is()` list. The settings panel's aria-label is the only handle Google leaves on
 * it, so its clause is a label union rather than a selector.
 */
function labelUnion(actionKey: string): string {
  return labelSelectors(domAction(actionKey)).join(', ');
}

export interface CalendarCssOptions {
  /** Let macOS vibrancy show through the page. */
  transparent?: boolean;
  /** Hide Google's companion rail — Keep, Tasks, Contacts. */
  hideSidebar?: boolean;
  /** Hide the top-right Calendar/Tasks switcher. */
  hideTasksTab?: boolean;
}

const BASE_CSS = `
/* Magical — clean desktop canvas */

/* Google's "get the app" and browser-upgrade interruptions */
div[role="alert"]:has(a[href*="google.com/chrome"]),
div[role="dialog"]:has(a[href*="play.google.com"]) {
  display: none !important;
}

/* Native macOS scrollbars */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(128,128,128,0.55); }
`;

/**
 * Only containers are cleared, never their descendants: Google Calendar paints
 * event chips, the current-time marker and the mini-month selection with
 * background colours, and a blanket rule erases all three.
 *
 * `html, body` is not enough on its own. Measuring the live page found exactly
 * two elements painting opaque over the whole window: the app shell, and the
 * week grid at `[role="grid"]`.
 *
 * The shell is cleared and the grid deliberately is not. Vibrancy then shows
 * through the drawer, the header strip and the margins, while the grid — the
 * one dense, read-all-day surface — keeps a solid background behind its events.
 *
 * The shell is the child of `body` holding the main region. Naming it that
 * precisely keeps the rule off Google's toast, which is another child of `body`
 * and paints its own background: `body > div` alone cleared the toast and left
 * near-white text over the desktop.
 */
const TRANSPARENT_CSS = `
html, body {
  background: transparent !important;
}
body > div:has([role="main"]) {
  background-color: transparent !important;
}
header[role="banner"],
div[role="banner"],
div[role="navigation"] {
  background-color: transparent !important;
}

/* Full-screen Tasks renders in a tab panel, not the week grid, so the shells
   above do not reach it. Google paints the panel, a class-named host around it
   and the iframe wrapper opaque; clearing all three lets vibrancy through. The
   host carries no role or data attribute, hence :has. */
div[role="tabpanel"],
div:has([role="tabpanel"]),
div[role="tabpanel"] div:has(> iframe) {
  background-color: transparent !important;
}

/* Dialogs, menus and settings stay opaque — vibrancy behind a settings form
   makes its text unreadable against whatever is on the desktop. The settings
   region is matched through the action map, so the clause is scoped to its
   language. */
div[role="dialog"],
div[role="menu"],
div[role="listbox"],
div[role="region"]:is(${labelUnion('settings')}) {
  background-color: Canvas !important;
}
`;

/**
 * Hides Google's companion rail — the Keep / Tasks / Contacts / Maps strip down
 * the right edge — and the button that reopens it.
 *
 * Not `getHideSidebarCss` from core, and not a bare `[role="complementary"]`
 * either. Both were tried against a signed-in calendar and both took too much:
 *
 * - Core's rule adds `div:has(> [role="complementary"])`. In Gmail that is a
 *   thin wrapper; in Google Calendar it is an ancestor of the whole week grid,
 *   so the toggle blanked the calendar down to its header and Create button.
 * - `[role="complementary"]` on its own is not the rail. Google Calendar puts
 *   the same role on left-drawer sections — Booking pages, My calendars, Other
 *   calendars — so hiding it took the calendar lists with it.
 *
 * `data-keeps-details-open` is the hook that actually identifies the rail: on a live
 * signed-in calendar it sits on the rail column, the panel itself and the wrapper
 * around the reopen button, and nowhere else. Matching it replaces the English
 * `aria-label*="side panel"` the rule used to depend on.
 */
const HIDE_SIDEBAR_CSS = `
${domSelector('sidePanel')} {
  display: none !important;
}
`;

/**
 * Hides the whole Calendar/Tasks switcher.
 *
 * Measured against a signed-in calendar: the switcher is a plain `div` holding a
 * `span`-wrapped `button` per app — Calendar and Tasks — and carries no role, no
 * authored id and no `data-*` state. Its one handle is the Tasks button's
 * accessible name, "Switch to Tasks", so the clause comes from the locale map and
 * carries its `:lang()` scope. `:has(> span[data-is-tooltip-wrapper] > button)`
 * reaches the container, so the whole segmented control goes, not just the button.
 *
 * Only the top switcher is hidden: the companion rail is left alone, so the Tasks
 * page still loads when reached from it or a link, and `leaveTasksRouteIfActive`
 * moves a view off the Tasks route when the setting is switched on.
 */
const HIDE_TASKS_TAB_CSS = `
div:has(> span[data-is-tooltip-wrapper] > button:is(${labelUnion('tasksTab')})) {
  display: none !important;
}
`;

export function getCalendarCss(options: CalendarCssOptions = {}): string {
  const { transparent = true, hideSidebar = false, hideTasksTab = false } = options;

  const parts = [BASE_CSS];
  if (transparent) parts.push(TRANSPARENT_CSS);
  if (hideSidebar) parts.push(HIDE_SIDEBAR_CSS);
  if (hideTasksTab) parts.push(HIDE_TASKS_TAB_CSS);
  return parts.join('\n');
}

export interface CalendarSubframeCssOptions {
  /** Let macOS vibrancy show through the subframe page. */
  transparent?: boolean;
}

/**
 * Subframe stylesheet injected into the Tasks embed (tasks.google.com), which
 * the top-frame rules cannot reach. Its transparent canvas renders white in
 * dark mode until the colour scheme is declared. Clears the three opaque layers
 * (body, the empty data-task-list-id wrapper and the navigation panel) without
 * touching the selected list's highlight or the task card.
 */
const SUBFRAME_TRANSPARENT_CSS = `
html {
  color-scheme: light dark;
}
html, body {
  background: transparent !important;
}
div[data-task-list-id=""],
div[role="navigation"] > div > div {
  background-color: transparent !important;
}
`;

export function getCalendarSubframeCss(options: CalendarSubframeCssOptions = {}): string {
  const { transparent = true } = options;
  return transparent ? SUBFRAME_TRANSPARENT_CSS : '';
}
