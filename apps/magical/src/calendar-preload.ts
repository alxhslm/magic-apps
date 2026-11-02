import { contextBridge, ipcRenderer } from 'electron';
import { applyMainWorldIdentity, chromeBrands, chromeFullVersionBrands } from '@magimail/core';
import { extractRawCalendarList, extractGaiaId, extractGoogleApiKey } from './calendar-list.js';
import {
  CALENDAR_LIST_CHANNEL,
  GCAL_GRID_SCROLL_CHANNEL,
  GCAL_VIEW_MODE_CHANNEL,
} from './constants.js';

/**
 * Completes the Chrome identity inside the Google Calendar page.
 *
 * `configureGoogleSession` makes the headers and `navigator.userAgent` name
 * branded Chrome, but it cannot reach `navigator.userAgentData`, which Electron
 * leaves reporting bare Chromium. Google scores the disagreement, not any single
 * value — headers claiming Chrome over a navigator that says Chromium is what
 * produces "This browser or app may not be secure" at sign-in.
 *
 * Magical does not load `@magimail/core/preload`: that one also installs Gmail's
 * mailbox-change observer, the `magimailBridge` API and the Gmail print-view
 * suppression, none of which mean anything here. Only the identity is shared,
 * from the same brand lists `session.ts` puts on the headers.
 *
 * Must run in the page's **main** world. With `contextIsolation: true` an
 * ordinary preload patch lands in the isolated world, where Google's scripts
 * never see it.
 */
try {
  contextBridge.executeInMainWorld({
    func: applyMainWorldIdentity,
    args: [chromeBrands(), chromeFullVersionBrands()],
  });
} catch {
  // A page that blocks the patch is still better than no page.
}

/**
 * Reports the account's calendars, read from the page Google served.
 *
 * `initialdata` is a script tag in the document itself, so this needs nothing from the
 * page's own code: the isolated world shares the DOM, and reading a tag out of it asks
 * no more of the page than the CSS injection already does.
 *
 * The alternative was to intercept the `sync.sync` response, which carries the same list.
 * It was built and dropped: that endpoint answers 403 without the opaque sync token the
 * web client builds, so the response has to be caught rather than asked for, and only a
 * *full* sync carries any calendars -- a client holding a usable token asks for a delta,
 * which carries none. Catching it also meant patching Google's own `XMLHttpRequest` from
 * the page's main world and passing the body back across a `window.postMessage` bridge,
 * all of which this replaces.
 */
function reportCalendars(): void {
  const tag = document.getElementById('initialdata');
  if (!tag?.textContent) return;

  try {
    const parsed = JSON.parse(tag.textContent);
    const calendars = extractRawCalendarList(parsed);
    const gaiaId = extractGaiaId(parsed);
    // Google's public browser key, read from the page rather than committed to the
    // repository. The main process cannot reach the page's `window`, and the script tag
    // carries the same object as text, so it is read here and relayed like the Gaia ID.
    const apiKey =
      extractGoogleApiKey(document.querySelector('script[data-id="_gd"]')?.textContent) ??
      extractGoogleApiKey(tag.textContent);
    if (calendars.length > 0 || gaiaId || apiKey) {
      ipcRenderer.send(CALENDAR_LIST_CHANNEL, {
        calendars,
        gaiaId: gaiaId ?? undefined,
        apiKey: apiKey ?? undefined,
      });
    }
  } catch {
    // A page whose shape this build cannot read leaves the account's calendars as they
    // are, which is better than clearing them.
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', reportCalendars, { once: true });
} else {
  reportCalendars();
}

/**
 * Observes Google Calendar's active timeframe and anchor date, relaying changes
 * to the main process so the native companion sidebar adapts its presentation.
 */
const VIEW_KEY_TO_TIMEFRAME: Record<string, string> = {
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
  CUSTOM_DAYS: 'customday',
  CUSTOM_WEEKS: 'week',
  YEAR: 'year',
  AGENDA: 'schedule',
  SCHEDULE: 'schedule',
};

let lastReportedTimeframe: string | null = null;
let lastReportedDate: string | null = null;

function checkViewMode(): void {
  const path = window.location.pathname;
  const match =
    /\/r\/(day|week|month|year|customday|customweek|agenda|schedule)(?:\/(\d{4})\/(\d{1,2})\/(\d{1,2}))?/.exec(
      path,
    );

  let timeframe: string | null = null;
  let dateStr: string | null = null;

  if (match) {
    timeframe = match[1];
    if (match[2] && match[3] && match[4]) {
      const y = match[2];
      const m = match[3].padStart(2, '0');
      const d = match[4].padStart(2, '0');
      dateStr = `${y}-${m}-${d}`;
    }
  }

  if (!timeframe) {
    const el = document.querySelector('[data-viewkey], [data-view-key], [data-view]');
    const rawKey =
      el?.getAttribute('data-viewkey') ||
      el?.getAttribute('data-view-key') ||
      el?.getAttribute('data-view');
    const key = rawKey?.toUpperCase();
    if (key && VIEW_KEY_TO_TIMEFRAME[key]) {
      timeframe = VIEW_KEY_TO_TIMEFRAME[key];
    }
  }

  if (!timeframe) return;

  if (!dateStr) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    dateStr = `${y}-${m}-${d}`;
  }

  if (timeframe !== lastReportedTimeframe || dateStr !== lastReportedDate) {
    lastReportedTimeframe = timeframe;
    lastReportedDate = dateStr;
    ipcRenderer.send(GCAL_VIEW_MODE_CHANNEL, {
      timeframe,
      dateStr,
    });
  }

  checkGridScrollContainer();
}

/**
 * Observes the main 24-hour time grid scroll container in Day, Week, and 4-Day views,
 * relaying the vertical scroll position and computed hour row height so the companion
 * sidebar's timeline aligns in lockstep.
 */
let activeScrollContainer: HTMLElement | null = null;
let lastReportedScrollTop = -1;
let lastReportedHourHeight = -1;
let scrollRaf: number | null = null;

function isTimeGridView(timeframe: string | null): boolean {
  if (!timeframe) return false;
  return ['day', 'week', 'customday', 'custom_days', 'fourday', '4day'].includes(
    timeframe.toLowerCase(),
  );
}

function measureHourHeight(container: HTMLElement): number {
  const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="row"]'));
  if (rows.length >= 2) {
    const r0 = rows[0].getBoundingClientRect();
    const r1 = rows[1].getBoundingClientRect();
    const diff = Math.abs(r1.top - r0.top);
    if (diff >= 24 && diff <= 120) {
      return diff;
    }
  }

  const scrollHeight = container.scrollHeight;
  if (scrollHeight >= 480) {
    return scrollHeight / 24;
  }

  return 48;
}

function findGridScrollContainer(): HTMLElement | null {
  const grid = document.querySelector('[role="grid"]');
  if (grid) {
    const gridDivs = Array.from(grid.querySelectorAll<HTMLElement>('div'));
    for (const el of gridDivs) {
      if (el.scrollHeight >= 700 && el.clientHeight > 150) {
        const style = window.getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          return el;
        }
      }
    }
    for (const el of gridDivs) {
      if (el.scrollHeight > el.clientHeight && el.clientHeight > 150) {
        const style = window.getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          return el;
        }
      }
    }
    let curr: HTMLElement | null = grid as HTMLElement;
    while (curr && curr !== document.body) {
      if (curr.scrollHeight > curr.clientHeight && curr.clientHeight > 150) {
        const style = window.getComputedStyle(curr);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          return curr;
        }
      }
      curr = curr.parentElement;
    }
  }

  const main = document.querySelector('[role="main"]') || document.body;
  const candidates = Array.from(main.querySelectorAll<HTMLElement>('div'));
  for (const el of candidates) {
    if (el.scrollHeight >= 700 && el.clientHeight > 150) {
      const style = window.getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return el;
      }
    }
  }
  for (const el of candidates) {
    if (el.scrollHeight > el.clientHeight && el.clientHeight > 200) {
      const style = window.getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
        return el;
      }
    }
  }
  return null;
}

function reportGridScroll(): void {
  if (!activeScrollContainer || !isTimeGridView(lastReportedTimeframe)) return;
  const scrollTop = activeScrollContainer.scrollTop;
  const hourHeight = measureHourHeight(activeScrollContainer);

  if (
    Math.abs(scrollTop - lastReportedScrollTop) < 0.5 &&
    Math.abs(hourHeight - lastReportedHourHeight) < 0.5
  ) {
    return;
  }
  lastReportedScrollTop = scrollTop;
  lastReportedHourHeight = hourHeight;

  const hour = scrollTop / hourHeight;

  ipcRenderer.send(GCAL_GRID_SCROLL_CHANNEL, {
    hour,
    hourHeight,
  });
}

function onScrollThrottled(): void {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    reportGridScroll();
  });
}

function checkGridScrollContainer(): void {
  if (!isTimeGridView(lastReportedTimeframe)) {
    if (activeScrollContainer) {
      activeScrollContainer.removeEventListener('scroll', onScrollThrottled);
      window.removeEventListener('resize', onScrollThrottled);
      activeScrollContainer = null;
      lastReportedScrollTop = -1;
      lastReportedHourHeight = -1;
    }
    return;
  }

  const container = findGridScrollContainer();
  if (container && container !== activeScrollContainer) {
    if (activeScrollContainer) {
      activeScrollContainer.removeEventListener('scroll', onScrollThrottled);
    }
    activeScrollContainer = container;
    activeScrollContainer.addEventListener('scroll', onScrollThrottled, { passive: true });
    window.addEventListener('resize', onScrollThrottled, { passive: true });
    reportGridScroll();
  } else if (activeScrollContainer) {
    reportGridScroll();
  }
}

let checkDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedCheckViewMode(): void {
  if (checkDebounceTimer) clearTimeout(checkDebounceTimer);
  checkDebounceTimer = setTimeout(checkViewMode, 80);
}

try {
  contextBridge.executeInMainWorld({
    func: () => {
      try {
        const origPush = history.pushState.bind(history);
        history.pushState = function (...args) {
          const result = origPush(...args);
          window.dispatchEvent(new Event('magical:navigation'));
          return result;
        };
        const origReplace = history.replaceState.bind(history);
        history.replaceState = function (...args) {
          const result = origReplace(...args);
          window.dispatchEvent(new Event('magical:navigation'));
          return result;
        };
      } catch {
        // Guard against restricted window contexts
      }
    },
    args: [],
  });
} catch {
  // Guard against restricted window contexts
}

try {
  const origPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    const result = origPushState(...args);
    debouncedCheckViewMode();
    return result;
  };

  const origReplaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    const result = origReplaceState(...args);
    debouncedCheckViewMode();
    return result;
  };
} catch {
  // Guard against restricted window contexts
}

window.addEventListener('popstate', debouncedCheckViewMode);
window.addEventListener('hashchange', debouncedCheckViewMode);
window.addEventListener('magical:navigation', debouncedCheckViewMode);

function attachViewObservers(): void {
  checkViewMode();
  let initialRetryCount = 0;
  const initialRetryTimer = setInterval(() => {
    initialRetryCount++;
    checkViewMode();
    if (initialRetryCount > 20) {
      clearInterval(initialRetryTimer);
    }
  }, 250);

  // Periodic check to capture view transitions that do not trigger DOM mutations or history events
  setInterval(checkViewMode, 1000);

  const observer = new MutationObserver(debouncedCheckViewMode);
  if (document.body) {
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-viewkey', 'data-view-key', 'data-view'],
    });
  }

  const titleEl = document.querySelector('title');
  if (titleEl) {
    const titleObserver = new MutationObserver(debouncedCheckViewMode);
    titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', attachViewObservers, { once: true });
} else {
  attachViewObservers();
}
