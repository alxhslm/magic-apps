/**
 * offline-page.ts
 *
 * The page that replaces an account's view when its load failed for want of a network.
 *
 * Shared because both apps need exactly the same thing: a view that has failed to load
 * shows Chromium's own error page, which names a Chrome error code, offers a reload that
 * fails again, and never mentions the app. The page below says which app cannot reach
 * which service, retries the URL that actually failed rather than reloading itself, and
 * retries again on its own when the connection returns.
 */

import type { UiTranslator } from './ui-strings.js';

/**
 * The catalogue keys the offline page renders, so an app can assert they exist.
 */
export const OFFLINE_PAGE_KEYS = [
  'offline.title',
  'offline.heading',
  'offline.body',
  'offline.retry',
] as const;

/** Chromium load failures that mean "no network", as opposed to a page that 404'd. */
const NETWORK_ERROR_CODES = new Set([
  -106, // net::ERR_INTERNET_DISCONNECTED
  -105, // net::ERR_NAME_NOT_RESOLVED
  -102, // net::ERR_CONNECTION_REFUSED
  -101, // net::ERR_CONNECTION_RESET
  -118, // net::ERR_CONNECTION_TIMED_OUT
  -109, // net::ERR_ADDRESS_UNREACHABLE
  // net::ERR_FAILED, which is what a navigation a service worker handled reports when
  // the worker cannot answer it. Google Calendar's offline worker takes every
  // navigation in its scope, so with this code excluded an account with offline mode
  // turned on got Chromium's blank error page instead of this one.
  -2,
]);

/**
 * Whether a `did-fail-load` was the network going away.
 *
 * `ERR_ABORTED` (-3) is excluded deliberately: it is what a navigation superseded by
 * another navigation reports, which happens constantly during sign-in redirects, and
 * treating it as an outage would replace a working page with an offline notice.
 */
export function isNetworkLoadFailure(errorCode: number): boolean {
  return NETWORK_ERROR_CODES.has(errorCode);
}

export interface OfflinePageOptions {
  /** The app's own name, so the page says what cannot reach what. */
  appName: string;
  /** What it was trying to reach, in the user's words: "Gmail", "Google Calendar". */
  serviceName: string;
  /** The URL that failed, retried on the button and on `online`. */
  retryUrl: string;
  isDark: boolean;
}

/** The offline page as a `data:` URL, ready for `loadURL`. */
export function offlinePageDataUrl(options: OfflinePageOptions, t: UiTranslator): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(renderOfflinePage(options, t))}`;
}

export function renderOfflinePage(
  { appName, serviceName, retryUrl, isDark }: OfflinePageOptions,
  t: UiTranslator,
): string {
  const bg = isDark ? '#1a1a1a' : '#f5f5f7';
  const fg = isDark ? '#ffffff' : '#1d1d1f';
  const sub = isDark ? '#a1a1a6' : '#86868b';
  const btnBg = isDark ? '#2c2c2e' : '#e5e5ea';
  const btnHover = isDark ? '#3a3a3c' : '#d1d1d6';
  const btnBorder = isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.15)';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${t('offline.title')}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif;
      background-color: ${bg};
      color: ${fg};
      height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      user-select: none;
      -webkit-user-select: none;
    }
    .container {
      text-align: center;
      max-width: 360px;
      padding: 24px;
    }
    .icon-wrapper {
      margin-bottom: 20px;
      color: ${sub};
    }
    h1 {
      font-size: 19px;
      font-weight: 600;
      margin-bottom: 8px;
      letter-spacing: -0.01em;
    }
    p {
      font-size: 13px;
      line-height: 1.4;
      color: ${sub};
      margin-bottom: 24px;
    }
    .retry-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 16px;
      font-size: 13px;
      font-weight: 500;
      color: ${fg};
      background: ${btnBg};
      border: 1px solid ${btnBorder};
      border-radius: 6px;
      cursor: pointer;
      outline: none;
      transition: background 0.15s ease;
    }
    .retry-button:hover {
      background: ${btnHover};
    }
    .retry-button:active {
      transform: scale(0.98);
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon-wrapper">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <line x1="1" y1="1" x2="23" y2="23"></line>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"></path>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"></path>
        <path d="M10.71 5.05A16 16 0 0 1 22.58 9"></path>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"></path>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
        <line x1="12" y1="20" x2="12.01" y2="20"></line>
      </svg>
    </div>
    <h1>${t('offline.heading')}</h1>
    <p>${t('offline.body', { app: appName, service: serviceName })}</p>
    <button class="retry-button" id="retryBtn">${t('offline.retry')}</button>
  </div>
  <script>
    const targetUrl = ${JSON.stringify(retryUrl)};
    function retry() {
      if (targetUrl) {
        window.location.href = targetUrl;
      } else {
        window.location.reload();
      }
    }
    document.getElementById('retryBtn').addEventListener('click', retry);
    window.addEventListener('online', retry);
  </script>
</body>
</html>`;
}
