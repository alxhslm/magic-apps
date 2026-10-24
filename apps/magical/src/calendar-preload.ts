import { contextBridge, ipcRenderer } from 'electron';
import { applyMainWorldIdentity, chromeBrands, chromeFullVersionBrands } from '@magimail/core';
import { extractRawCalendarList, extractGaiaId, extractGoogleApiKey } from './calendar-list.js';
import { CALENDAR_LIST_CHANNEL } from './constants.js';

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
