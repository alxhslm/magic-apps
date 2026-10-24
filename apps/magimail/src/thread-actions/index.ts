export * from './types.js';
export * from './sync-driver.js';
export * from './dom-driver.js';
export * from './fallback-driver.js';

import { DomThreadActionDriver, type DomThreadActionHost } from './dom-driver.js';
import { SyncThreadActionDriver, type SyncThreadActionDriverOptions } from './sync-driver.js';
import { FallbackThreadActionDriver } from './fallback-driver.js';
import type { ThreadActionDriver } from './types.js';

/**
 * Builds the driver stack a window drives triage through.
 *
 * The window answers a host interface for the DOM fallback and passes the direct driver
 * its own options, so neither reaches back into the window for the other's state.
 */
export function createDefaultThreadActionDriver(
  host: DomThreadActionHost,
  syncOptions: SyncThreadActionDriverOptions,
): ThreadActionDriver {
  const domDriver = new DomThreadActionDriver(host);
  const syncDriver = new SyncThreadActionDriver(syncOptions);
  return new FallbackThreadActionDriver(syncDriver, domDriver);
}
