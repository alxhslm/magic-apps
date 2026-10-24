import { describe, it, expect } from 'vitest';
import { isNetworkLoadFailure, offlinePageDataUrl, renderOfflinePage } from '../src/offline-page';
import type { UiTranslator } from '../src/ui-strings.js';

const options = {
  appName: 'Magical',
  serviceName: 'Google Calendar',
  retryUrl: 'https://calendar.google.com/calendar/u/0/r/week',
  isDark: false,
};

/** The English the app supplies, with core's app and service names filled in. */
const t: UiTranslator = (key, params) => {
  switch (key) {
    case 'offline.title':
      return 'Offline';
    case 'offline.heading':
      return "You're offline";
    case 'offline.body':
      return `${params?.app} can't reach ${params?.service}.`;
    case 'offline.retry':
      return 'Try again';
    default:
      throw new Error(`unexpected key ${key}`);
  }
};

describe('isNetworkLoadFailure', () => {
  it('recognises the codes that mean there is no network', () => {
    expect(isNetworkLoadFailure(-106)).toBe(true); // ERR_INTERNET_DISCONNECTED
    expect(isNetworkLoadFailure(-105)).toBe(true); // ERR_NAME_NOT_RESOLVED
    expect(isNetworkLoadFailure(-118)).toBe(true); // ERR_CONNECTION_TIMED_OUT
  });

  it('recognises a service worker that could not answer the navigation', () => {
    // A navigation a service worker handled reports ERR_FAILED rather than the code
    // underneath it. Google Calendar's offline worker takes every navigation in its
    // scope, so excluding this left an account with offline mode on staring at
    // Chromium's blank error page.
    expect(isNetworkLoadFailure(-2)).toBe(true);
  });

  it('leaves an aborted navigation alone', () => {
    // A navigation superseded by another reports ERR_ABORTED, which happens constantly
    // through Google's sign-in redirects. Treating it as an outage would replace a page
    // that is loading perfectly well with an offline notice.
    expect(isNetworkLoadFailure(-3)).toBe(false);
  });

  it('leaves an HTTP error alone', () => {
    // The server answered, so the network is fine; this page would say the opposite.
    expect(isNetworkLoadFailure(404)).toBe(false);
    expect(isNetworkLoadFailure(0)).toBe(false);
  });
});

describe('renderOfflinePage', () => {
  it('names the app and the service it cannot reach', () => {
    const html = renderOfflinePage(options, t);
    expect(html).toContain("Magical can't reach Google Calendar.");
  });

  it('renders the strings the catalogue supplies, not its own wording', () => {
    const html = renderOfflinePage(options, (key) => `[${key}]`);
    expect(html).toContain('<title>[offline.title]</title>');
    expect(html).toContain('<h1>[offline.heading]</h1>');
    expect(html).toContain('>[offline.retry]<');
  });

  it('retries the URL that failed rather than reloading itself', () => {
    // The page is a `data:` URL, so a plain reload would redraw the offline notice
    // forever. A month paged to, or a link followed from a banner, is what the user
    // wants back.
    const html = renderOfflinePage(options, t);
    expect(html).toContain(JSON.stringify(options.retryUrl));
  });

  it('retries on its own once the connection returns', () => {
    expect(renderOfflinePage(options, t)).toContain("window.addEventListener('online', retry)");
  });

  it('paints its own background in both themes', () => {
    // The view sits over the window's vibrancy, so a page without an opaque background
    // shows the desktop through it.
    expect(renderOfflinePage({ ...options, isDark: true }, t)).toContain('#1a1a1a');
    expect(renderOfflinePage({ ...options, isDark: false }, t)).toContain('#f5f5f7');
  });

  it('escapes into a data URL that loadURL accepts', () => {
    const url = offlinePageDataUrl(options, t);
    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true);
    expect(url).not.toContain(' ');
  });
});
