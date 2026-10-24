import { session, type Session } from 'electron';
import { DEFAULT_CLEAN_USER_AGENT, CHROME_USER_AGENT } from './constants.js';
import { chromeBrands, chromeFullVersionBrands, serialiseBrands } from './browser-identity.js';

/**
 * Sanitizes User-Agent by removing Electron and automation tokens
 */
export function sanitizeUserAgent(ua?: string): string {
  if (!ua || ua.includes('Electron')) {
    return DEFAULT_CLEAN_USER_AGENT;
  }
  return ua
    .replace(/Electron\/[0-9.]+\s*/gi, '')
    .replace(/magimail\/[0-9.]+\s*/gi, '')
    .trim();
}

/** Chromium hands us either casing, so clear both before writing one. */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
  delete headers[name.toLowerCase()];
  headers[name] = value;
}

/**
 * Configures an isolated Google session partition with a single Chrome identity:
 * headers, Client Hints and the page's own `navigator` all name the Chromium
 * actually running. There is no auth-endpoint branching — see
 * `docs/shared/sessions-and-security.md#browser-identity-and-authentication` for why the Safari split went.
 */
export function configureGoogleSession(
  partitionName?: string,
  customUA: string = DEFAULT_CLEAN_USER_AGENT,
): Session {
  const ses = partitionName ? session.fromPartition(partitionName) : session.defaultSession;
  const cleanUA = sanitizeUserAgent(customUA);

  // Governs `navigator.userAgent` in the page as well as the default header.
  ses.setUserAgent(cleanUA);

  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const requestHeaders = { ...details.requestHeaders };

    delete requestHeaders['X-Electron-Version'];
    delete requestHeaders['x-electron-version'];

    setHeader(requestHeaders, 'User-Agent', CHROME_USER_AGENT);

    // Electron sends no Sec-CH-UA headers while still exposing
    // `navigator.userAgentData`; Chrome sends both. Supplied from the same lists
    // the preload installs in the page, and only on secure origins, as Chrome does.
    if (details.url.startsWith('https://')) {
      setHeader(requestHeaders, 'Sec-CH-UA', serialiseBrands(chromeBrands()));
      setHeader(requestHeaders, 'Sec-CH-UA-Mobile', '?0');
      setHeader(requestHeaders, 'Sec-CH-UA-Platform', '"macOS"');
      setHeader(
        requestHeaders,
        'Sec-CH-UA-Full-Version-List',
        serialiseBrands(chromeFullVersionBrands()),
      );
    }

    // Sec-CH-UA-Platform-Version is deliberately omitted: high-entropy, so Chrome
    // states it only on request, and we have no honest value here. Saying nothing
    // cannot contradict what the page reports.

    callback({ cancel: false, requestHeaders });
  });

  return ses;
}
