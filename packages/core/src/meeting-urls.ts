/**
 * Whether a link is a meeting, which is the only kind of link an account's browser profile is
 * applied to.
 *
 * Two reasons it is this narrow. A meeting is the link where the wrong Google session actually
 * costs something: the call asks to be let in, or joins as nobody. And applying a profile means
 * starting the browser ourselves, which is exactly what stops macOS handing a URL to the desktop
 * app that claims its domain, so it is done only where the profile is worth that.
 *
 * Hosts rather than a URL pattern, and a short list rather than a catalogue: a meeting link that
 * is not named here falls through to macOS, which either opens the desktop client or the site in
 * the default browser. That is the safe direction to be wrong in.
 */
const MEETING_HOSTS = [
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
  'teams.live.com',
  'webex.com',
  'gotomeeting.com',
  'bluejeans.com',
  'whereby.com',
];

/** Matches the host and any subdomain of it, so `us02web.zoom.us` counts. */
export function isMeetingUrl(rawUrl: string): boolean {
  let host: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }

  return MEETING_HOSTS.some(
    (meetingHost) => host === meetingHost || host.endsWith(`.${meetingHost}`),
  );
}
