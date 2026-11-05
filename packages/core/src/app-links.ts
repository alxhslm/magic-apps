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

/**
 * What to do when a link belongs to a desktop app.
 *
 * `auto` opens the app, `ask` puts the choice in front of the user once per domain, and `never`
 * ignores the table so every link takes the browser and the account's profile.
 */
export type AppLinkMode = 'auto' | 'ask' | 'never';

/** A remembered answer, keyed by host, so `ask` only asks once. */
export type AppLinkOverrides = Record<string, 'app' | 'browser'>;

export interface AppLinkDecision {
  /** True when the link should go to the app rather than the browser. */
  useApp: boolean;
}

/**
 * Whether this link belongs to its app, given the mode, any remembered answer, and the user.
 *
 * Separate from routing so the decision can be tested without a browser, an app or a dialog.
 */
export async function appLinkDecision(
  app: AppLink,
  host: string,
  mode: AppLinkMode,
  remember: AppLinkOverrides | undefined,
  ask?: (app: AppLink, host: string) => Promise<{ choice: 'app' | 'browser'; remember: boolean }>,
): Promise<AppLinkDecision> {
  if (mode === 'never') return { useApp: false };

  const remembered = remember?.[host.toLowerCase()];
  if (remembered) return { useApp: remembered === 'app' };

  if (mode === 'auto' || !ask) return { useApp: true };

  const answer = await ask(app, host);
  return { useApp: answer.choice === 'app' };
}

/** The host a remembered answer is keyed by: the address bar's, lowercased. */
export function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
