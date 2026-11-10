/**
 * links.ts
 *
 * URL unwrapping and redirection utilities shared across Magic Apps.
 */

/**
 * Candidate query parameter names commonly used by tracking redirectors,
 * email analytics, and click trackers to hold the destination URL.
 */
const CANDIDATE_REDIRECT_PARAMS = [
  'url',
  'q',
  'dest',
  'destination',
  'target',
  'target_url',
  'redirect',
  'redirect_url',
  'link',
  'goto',
  'to',
  'next',
  'r',
  'u',
] as const;

/**
 * Standard query parameter names used by OAuth and SSO authorization endpoints
 * that must not be treated as generic tracking wrappers.
 */
const OAUTH_PARAMS = new Set(['redirect_uri', 'return_to', 'callback', 'post_logout_redirect_uri']);

function isValidDestinationUrl(candidate: string | null): candidate is string {
  if (!candidate || typeof candidate !== 'string') return false;
  try {
    const parsed = new URL(candidate);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Inspects a parsed URL's query parameters to extract an encapsulated destination URL.
 * First checks common tracking/redirect parameter names, then falls back to any query
 * parameter containing an absolute http(s) URL while safely ignoring OAuth parameters.
 */
function extractGenericRedirectDestination(parsed: URL): string | null {
  // If the URL looks like an OAuth / SSO authorization request, do not unwrap it.
  if (parsed.searchParams.has('response_type') && parsed.searchParams.has('client_id')) {
    return null;
  }

  for (const name of CANDIDATE_REDIRECT_PARAMS) {
    const value = parsed.searchParams.get(name);
    if (isValidDestinationUrl(value)) return value;
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (OAUTH_PARAMS.has(key.toLowerCase())) continue;
    if (isValidDestinationUrl(value)) return value;
  }

  return null;
}

/**
 * Unwraps redirector URLs (e.g. Google outbound `google.com/url?q=`, Outlook Safelinks,
 * or generic tracking/analytics redirectors carrying destination parameters like `dest=`, `url=`, etc.)
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

    const inner = extractGenericRedirectDestination(parsed);
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
    const pwd = /[?&]pwd=([^&#]+)/.exec(unwrapped)?.[1];
    return `zoommtg://zoom.us/join?action=join&confno=${zoom[1]}${pwd ? `&pwd=${pwd}` : ''}`;
  }
  if (/^https?:\/\/teams\.(microsoft\.com|live\.com|cloud\.microsoft)\//.test(unwrapped)) {
    return unwrapped.replace(/^https?:\/\//, 'msteams://');
  }
  return unwrapped;
}
