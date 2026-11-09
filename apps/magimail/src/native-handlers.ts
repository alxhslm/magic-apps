import { createLogger } from '@magimail/core/logger';
import { loadAddon } from './native-addon.js';

const log = createLogger('NativeHandlers');

/** One answer per scheme, for as long as the app runs. */
const handlers = new Map<string, boolean>();

/**
 * Whether macOS has an application registered to open this URL.
 *
 * Asked through the N-API addon, because `NSWorkspace.URLForApplicationToOpenURL:` is the
 * only thing that knows and Electron cannot reach it. Dispatching the URL and watching it
 * fail is not an alternative: `shell.openExternal` resolves whether or not macOS found a
 * handler, and the user sees the system's "no application is set to open the URL" dialog
 * either way.
 *
 * The answer is remembered per scheme, which is how LaunchServices resolves a custom
 * scheme anyway. Installing Teams halfway through a session is rare, and a LaunchServices
 * lookup on every join is not free.
 *
 * Says no when it cannot ask. The caller's fallback is the web URL, which works with or
 * without the desktop client, so a missing addon costs a browser tab rather than a dialog.
 */
export function hasApplicationForUrl(url: string): boolean {
  const colon = url.indexOf(':');
  if (colon < 1) return false;
  const scheme = url.slice(0, colon).toLowerCase();

  const remembered = handlers.get(scheme);
  if (remembered !== undefined) return remembered;

  let installed = false;
  try {
    installed = loadAddon().hasApplicationForUrl?.(url) ?? false;
  } catch (err) {
    log.warn(`Could not ask macOS about ${scheme}:`, err);
  }

  handlers.set(scheme, installed);
  return installed;
}

/** Forgets every remembered answer. Tests only. */
export function clearHandlerCache(): void {
  handlers.clear();
}
