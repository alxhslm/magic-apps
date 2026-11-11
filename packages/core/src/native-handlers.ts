import { createLogger } from './logger.js';
import type { LogSink } from './types.js';

export interface NativeHandlerRegistry {
  hasApplicationForUrl(url: string): boolean;
  clearHandlerCache(): void;
}

/**
 * Creates a per-scheme caching LaunchServices registry.
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
export function createNativeHandlerRegistry(
  lookup: () => ((url: string) => boolean) | undefined,
  logger: LogSink = createLogger('NativeHandlers'),
): NativeHandlerRegistry {
  const handlers = new Map<string, boolean>();

  return {
    hasApplicationForUrl(url: string): boolean {
      const colon = url.indexOf(':');
      if (colon < 1) return false;
      const scheme = url.slice(0, colon).toLowerCase();

      const remembered = handlers.get(scheme);
      if (remembered !== undefined) return remembered;

      let installed = false;
      try {
        installed = lookup()?.(url) ?? false;
      } catch (err) {
        logger.warn(`Could not ask macOS about ${scheme}:`, err);
      }

      handlers.set(scheme, installed);
      return installed;
    },

    clearHandlerCache(): void {
      handlers.clear();
    },
  };
}
