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
