/**
 * links.ts
 *
 * URL unwrapping and redirection utilities shared across Magic Apps.
 */

/**
 * Unwraps redirector URLs (e.g. Google outbound `google.com/url?q=` or Outlook Safelinks)
 * to reveal the direct destination URL.
 */
export function unwrapRedirectors(rawUrl: string): string {
  let url = rawUrl;
  for (let hop = 0; hop < 3; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return url;
    }
    const isGoogle = parsed.hostname === 'google.com' || parsed.hostname.endsWith('.google.com');
    const isSafelinks = parsed.hostname.endsWith('safelinks.protection.outlook.com');
    const inner =
      isGoogle && parsed.pathname === '/url'
        ? parsed.searchParams.get('q') || parsed.searchParams.get('url')
        : isSafelinks
          ? parsed.searchParams.get('url')
          : null;
    if (!inner) return url;
    url = inner;
  }
  return url;
}

/**
 * Rewrites a recognised video conference web URL to its native desktop scheme.
 *
 * Zoom and Teams support custom schemes that join the meeting in the native client
 * directly. Google Meet has no native client and Webex is kept in the browser.
 */
export function toNativeMeetingUrl(url: string): string {
  const unwrapped = unwrapRedirectors(url);
  const zoom = /^https?:\/\/[^/]*zoom\.us\/[jw]\/(\d+)/.exec(unwrapped);
  if (zoom) {
    const pwd = /[?&]pwd=([^&]+)/.exec(unwrapped)?.[1];
    return `zoommtg://zoom.us/join?action=join&confno=${zoom[1]}${pwd ? `&pwd=${pwd}` : ''}`;
  }
  if (/^https?:\/\/teams\.(microsoft|live)\.com\//.test(unwrapped)) {
    return unwrapped.replace(/^https?:\/\//, 'msteams://');
  }
  return unwrapped;
}
