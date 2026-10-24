export * from './types.js';
export * from './dom-driver.js';
export * from './sync-driver.js';
export * from './tasks-write.js';
export * from './fallback-driver.js';

import type { CalendarActionDriver } from './types.js';
import { DomCalendarActionDriver, type DomActionHost } from './dom-driver.js';
import { SyncCalendarActionDriver, type SyncCalendarActionDriverOptions } from './sync-driver.js';
import { FallbackCalendarActionDriver } from './fallback-driver.js';

/** The driver stack a window builds once and drives through. */
export interface CalendarActionStack {
  /** RSVP, delete and task completion: the sync API first, the page as fallback. */
  actions: CalendarActionDriver;

  /** The page itself, for the work the sync API does not do. */
  dom: DomCalendarActionDriver;
}

export function createCalendarActionDriver(
  host: DomActionHost,
  syncOptions: SyncCalendarActionDriverOptions,
): CalendarActionStack {
  const dom = new DomCalendarActionDriver(host);
  const sync = new SyncCalendarActionDriver(syncOptions);
  return { actions: new FallbackCalendarActionDriver(sync, dom), dom };
}
