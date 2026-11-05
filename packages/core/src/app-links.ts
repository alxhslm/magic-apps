import table from './app-links.json';

/**
 * Domains whose links belong in a desktop app.
 *
 * The table is data (`app-links.json`) so adding an app is one object and not a code change:
 * a name, the bundle id macOS launches, and the hosts it owns. Hosts cover themselves and their
 * subdomains, so `notion.so` answers for `www.notion.so` as well.
 */
export interface AppLink {
  name: string;
  bundleId: string;
  hosts: string[];
}

/**
 * The app that owns this URL's host, or `null`.
 *
 * Deliberately a hand-written list rather than anything clever: macOS's own universal-link
 * resolution cannot be queried (every LaunchServices call answers with a browser, and the
 * registry that knows needs root), and applying an account's browser profile means starting the
 * browser ourselves, which skips that resolution. Naming an app here is how a link gets to it
 * while every other link keeps the account's profile.
 *
 * Google's own domains are absent on purpose: a Drive or Docs link has to open in the account's
 * profile, which is the point of the setting.
 */
export function appForUrl(rawUrl: string): AppLink | null {
  let host: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  for (const entry of readApps()) {
    if (
      entry.hosts.some((owned) => {
        const ownedHost = owned.toLowerCase();
        return host === ownedHost || host.endsWith(`.${ownedHost}`);
      })
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * The table, validated.
 *
 * It ships inside the app, so a malformed entry is a build mistake rather than user input. It is
 * dropped rather than thrown over, because the cost of an unreadable entry is a link that opens
 * in the browser, and the cost of throwing is a link that does not open at all.
 */
export function readApps(): AppLink[] {
  const raw = (table as { apps?: unknown }).apps;
  if (!Array.isArray(raw)) return [];

  const apps: AppLink[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, bundleId, hosts } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || typeof bundleId !== 'string' || !bundleId) continue;
    if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== 'string' || !host)) continue;
    apps.push({ name, bundleId, hosts: hosts as string[] });
  }
  return apps;
}
