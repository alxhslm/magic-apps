import { TITLEBAR_HEIGHT } from './constants.js';

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the Google Calendar view sits inside the window's content area.
 *
 * The whole content area minus the titlebar strip. Kept as a function rather
 * than inlined at the one call site because it is the piece the companion
 * drawer will have to split when it arrives, and because getting the inset
 * wrong puts Google's header under the traffic lights — visible, but only if
 * someone looks.
 */
export function layoutCalendarView(contentWidth: number, contentHeight: number): ViewBounds {
  return {
    x: 0,
    y: TITLEBAR_HEIGHT,
    width: Math.max(0, contentWidth),
    height: Math.max(0, contentHeight - TITLEBAR_HEIGHT),
  };
}
