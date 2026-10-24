import { describe, it, expect } from 'vitest';
import { getCalendarCss, getCalendarSubframeCss } from '../src/calendar-css.js';

describe('getCalendarCss', () => {
  it('uses no Google class names', () => {
    // Google Calendar's classes are minified and rotate without notice. A
    // selector like `.aeN` fails silently, as a flash of unstyled chrome.
    const css = getCalendarCss({ hideSidebar: true });
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(selectors).not.toMatch(/(^|[\s,>])\.[a-zA-Z][\w-]*/m);
  });

  it('clears containers for vibrancy without clearing their descendants', () => {
    const css = getCalendarCss({ transparent: true });
    expect(css).toContain('header[role="banner"]');
    // A descendant wildcard would erase event chips and the current-time marker.
    expect(css).not.toMatch(/\[role="banner"\]\s*\*/);
    expect(css).not.toMatch(/\[role="navigation"\]\s*\*/);
  });

  it('clears the app shell, which is what actually paints over the window', () => {
    // Measured on the live page: `html, body` are already transparent, and the
    // two elements painting opaque full-window are the shell (rgb(27,27,27))
    // and the grid. Clearing html/body alone changed nothing.
    expect(getCalendarCss({ transparent: true })).toContain('body > div:has([role="main"])');
  });

  it('leaves the week grid opaque', () => {
    // Deliberate: the grid is the one dense, read-all-day surface, and events
    // over desktop vibrancy are harder to read than events on a solid panel.
    const css = getCalendarCss({ transparent: true });
    expect(css).not.toMatch(/\[role="grid"\][^{]*\{[^}]*background/);
  });

  it('clears no child of body but the shell', () => {
    // Google renders its toast as another child of `body`, painting the
    // background on the toast itself. An unqualified `body > div` cleared it
    // and left near-white text over the desktop.
    const css = getCalendarCss({ transparent: true });
    expect(css).not.toMatch(/^body > div[\s,{]/m);
  });

  it('clears the Tasks tab panel and its host so vibrancy shows through', () => {
    // The Tasks route renders in div[role="tabpanel"]; Google paints it, a
    // class-named host and the iframe wrapper opaque. :has reaches the host,
    // which carries no semantic attribute.
    const css = getCalendarCss({ transparent: true });
    expect(css).toMatch(/div\[role="tabpanel"\][\s\S]*?background-color: transparent/);
    expect(css).toContain('div:has([role="tabpanel"])');
  });

  it('does not force an opaque background on the main region', () => {
    // The week grid already paints its own surface; forcing Canvas on
    // div[role="main"] is what blocked vibrancy behind the Tasks route.
    const css = getCalendarCss({ transparent: true });
    expect(css).not.toMatch(/div\[role="main"\][^{]*\{[^}]*background/);
  });

  it('keeps dialogs and menus opaque', () => {
    const css = getCalendarCss({ transparent: true });
    expect(css).toMatch(/div\[role="dialog"\][\s\S]*?background-color: Canvas/);
    expect(css).toMatch(/div\[role="menu"\][\s\S]*?background-color: Canvas/);
  });

  it('leaves the page opaque when transparency is off', () => {
    const css = getCalendarCss({ transparent: false });
    expect(css).not.toContain('background: transparent !important');
  });

  it('never hides the banner, which carries all of the navigation', () => {
    // Nothing in Phase 1 replaces Today, the date arrows or the view switcher,
    // so hiding the banner would leave the app with no navigation at all.
    const css = getCalendarCss({ transparent: true, hideSidebar: true });
    expect(css).not.toMatch(/header\[role="banner"\][^{]*\{[^}]*display:\s*none/);
  });

  it('hides the companion rail only when asked', () => {
    expect(getCalendarCss({ hideSidebar: false })).not.toContain('[data-keeps-details-open]');
    expect(getCalendarCss({ hideSidebar: true })).toContain('[data-keeps-details-open]');
  });

  it('never hides an ancestor of the companion rail', () => {
    // Core's Gmail rule also hides `div:has(> [role="complementary"])`. In
    // Google Calendar that ancestor wraps the week grid too, so the toggle
    // blanked the entire calendar — header and Create button only. Confirmed
    // against a signed-in calendar, which is the only place it is visible.
    const css = getCalendarCss({ hideSidebar: true });
    expect(css).not.toMatch(/:has\([^)]*complementary/);
  });

  it('matches the rail by its own hook, not by role or an English label', () => {
    // Google Calendar puts role="complementary" on left-drawer sections too —
    // Booking pages, My calendars, Other calendars — so an unqualified
    // `[role="complementary"]` took the calendar lists with the rail. The rail,
    // its panel and the wrapper around the reopen button are the only elements on
    // a live page carrying `data-keeps-details-open`, so that is the handle.
    const css = getCalendarCss({ transparent: false, hideSidebar: true });
    expect(css).toContain('[data-keeps-details-open]');
    expect(css).not.toContain('aria-label');
  });

  it('scopes the settings label clause to its language', () => {
    // The settings region is matched through the locale action map, so a page in
    // another language is not styled as though its aria-label were English.
    const css = getCalendarCss({ transparent: true });
    expect(css).toContain('div[role="region"]:is(');
    expect(css).toContain('[aria-label*="settings" i]:lang(en)');
  });

  it('defaults to leaving the sidebar alone', () => {
    expect(getCalendarCss()).not.toContain('[data-keeps-details-open]');
  });

  it('hides the Tasks switcher only when asked', () => {
    expect(getCalendarCss({ hideTasksTab: false })).not.toContain('switch to tasks');
    expect(getCalendarCss({ hideTasksTab: true })).toContain('switch to tasks');
  });

  it('hides the whole switcher container, anchored on the Tasks label', () => {
    // Measured on a live calendar: the switcher is a div wrapping one
    // span-tooltip-wrapped button per app, and the Tasks button's accessible name
    // is the only handle on it. The container is reached with :has, so both the
    // Calendar and Tasks segments go.
    const css = getCalendarCss({ hideTasksTab: true });
    expect(css).toContain('div:has(> span[data-is-tooltip-wrapper] > button:is(');
    expect(css).toContain('[aria-label^="switch to tasks" i]:lang(en)');
  });

  it('never hides the companion rail tablist', () => {
    // The only `[role="tablist"]` on a live page is the rail's app strip (Keep,
    // Tasks, Contacts, Maps). An issue-proposed `[role="tablist"]:has(Tasks)`
    // hides that instead of the switcher, taking the companion sidebar with it.
    const css = getCalendarCss({ hideTasksTab: true });
    expect(css).not.toContain('[role="tablist"]');
    expect(css).not.toContain('[role="tab"]');
  });

  it('leaves the Tasks page itself reachable when the switcher is hidden', () => {
    // Only the top switcher is hidden; the companion rail's Tasks icon and a
    // direct route still load the page, which keeps the feature reachable.
    const css = getCalendarCss({ hideTasksTab: true });
    expect(css).not.toContain('[data-keeps-details-open]');
    expect(css).not.toMatch(/\[role="tabpanel"\][^{]*\{[^}]*display:\s*none/);
  });

  it('defaults to leaving the Tasks switcher alone', () => {
    expect(getCalendarCss()).not.toContain('switch to tasks');
  });
});

describe('getCalendarSubframeCss', () => {
  it('uses no Google class names', () => {
    const css = getCalendarSubframeCss({ transparent: true });
    const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(selectors).not.toMatch(/(^|[\s,>])\.[a-zA-Z][\w-]*/m);
  });

  it('clears the embed body, its empty wrapper and the navigation panel', () => {
    // The transparent canvas is white in dark mode until the colour scheme is
    // declared; body, the empty-id wrapper and the navigation panel are the
    // opaque layers.
    const css = getCalendarSubframeCss({ transparent: true });
    expect(css).toContain('color-scheme: light dark');
    expect(css).toContain('html, body');
    expect(css).toContain('div[data-task-list-id=""]');
    expect(css).toContain('div[role="navigation"] > div > div');
    expect(css).not.toMatch(/\[data-task-list-id\]:not/);
  });

  it('returns empty string when transparency is off', () => {
    expect(getCalendarSubframeCss({ transparent: false })).toBe('');
  });
});
