import { contextBridge, ipcRenderer } from 'electron';
import { applyMainWorldIdentity, chromeBrands, chromeFullVersionBrands } from '@magimail/core';
import { extractRawCalendarList, extractGaiaId, extractGoogleApiKey } from './calendar-list.js';
import { CALENDAR_LIST_CHANNEL, GCAL_VIEW_MODE_CHANNEL } from './constants.js';

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
    const el = document.querySelector('[data-viewkey]');
    const key = el?.getAttribute('data-viewkey')?.toUpperCase();
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
}

let checkDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedCheckViewMode(): void {
  if (checkDebounceTimer) clearTimeout(checkDebounceTimer);
  checkDebounceTimer = setTimeout(checkViewMode, 80);
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

function attachViewObservers(): void {
  checkViewMode();
  let retryCount = 0;
  const retryTimer = setInterval(() => {
    retryCount++;
    checkViewMode();
    if (retryCount > 20 || (lastReportedTimeframe && lastReportedDate)) {
      clearInterval(retryTimer);
    }
  }, 250);

  const observer = new MutationObserver(debouncedCheckViewMode);
  if (document.body) {
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-viewkey'],
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
