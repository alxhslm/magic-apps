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
 * What to do when a link belongs to a desktop app, chosen per app in Settings.
 *
 * `auto` opens the app, `ask` shows the choice each time, and `never` sends the link to the browser
 * with the account's profile.
 */
export type AppLinkMode = 'auto' | 'ask' | 'never';

/** The user's answer for each app, keyed by bundle id. An absent key means `auto`. */
export type AppLinkChoices = Record<string, AppLinkMode>;

export interface AppLinkDecision {
  /** True when the link should go to the app rather than the browser. */
  useApp: boolean;
}

/** What the user answered when asked, and whether that answer should become the setting. */
export interface AppLinkAnswer {
  choice: 'app' | 'browser';
  dontAskAgain: boolean;
}

/**
 * Whether this link belongs to its app, given that app's setting and, for `ask`, the user.
 *
 * Separate from routing so the three modes and the asking path can be tested without a browser, a
 * desktop app or a dialog.
 */
export async function appLinkDecision(
  app: AppLink,
  mode: AppLinkMode,
  ask?: (app: AppLink) => Promise<AppLinkAnswer>,
): Promise<AppLinkDecision> {
  if (mode === 'never') return { useApp: false };
  if (mode === 'auto' || !ask) return { useApp: true };

  return { useApp: (await ask(app)).choice === 'app' };
}

/** The setting a remembered answer becomes: always in the app, or never again. */
export function modeFromAnswer(answer: AppLinkAnswer): AppLinkMode {
  return answer.choice === 'app' ? 'auto' : 'never';
}

/** The mode chosen for an app, defaulting to `auto`. */
export function appLinkMode(app: AppLink, choices: AppLinkChoices | undefined): AppLinkMode {
  const chosen = choices?.[app.bundleId];
  return chosen === 'ask' || chosen === 'never' ? chosen : 'auto';
}

/** The host a remembered answer is keyed by: the address bar's, lowercased. */
export function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}
