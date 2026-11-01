import { TITLEBAR_HEIGHT } from './constants.js';

export const SIDEBAR_WIDTH = 280;
export const CALENDAR_MIN_WIDTH = 1280;
export const CALENDAR_MIN_HEIGHT = 600;

/**
 * Minimum window width guaranteeing Google Calendar has at least CALENDAR_MIN_WIDTH,
 * adding extra room for the companion sidebar when visible.
 */
export function windowMinWidth(
  sidebarVisible: boolean,
  sidebarWidth: number = SIDEBAR_WIDTH,
): number {
  return CALENDAR_MIN_WIDTH + (sidebarVisible ? Math.max(0, sidebarWidth) : 0);
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutOptions {
  sidebarVisible?: boolean;
  sidebarPosition?: 'left' | 'right';
  sidebarWidth?: number;
}

/**
 * Where the Google Calendar view sits inside the window's content area.
 *
 * The whole content area minus the titlebar strip, adjusting for the companion
 * sidebar when visible.
 */
export function layoutCalendarView(
  contentWidth: number,
  contentHeight: number,
  options?: LayoutOptions,
): ViewBounds {
  const isVisible = options?.sidebarVisible ?? false;
  const width = options?.sidebarWidth ?? SIDEBAR_WIDTH;
  const position = options?.sidebarPosition ?? 'right';
  const effectiveWidth = isVisible ? Math.max(0, width) : 0;
  const availHeight = Math.max(0, contentHeight - TITLEBAR_HEIGHT);
  const availWidth = Math.max(0, contentWidth - effectiveWidth);

  if (position === 'left') {
    return {
      x: effectiveWidth,
      y: TITLEBAR_HEIGHT,
      width: availWidth,
      height: availHeight,
    };
  }

  return {
    x: 0,
    y: TITLEBAR_HEIGHT,
    width: availWidth,
    height: availHeight,
  };
}

/**
 * Where the companion sidebar sits inside the window's content area.
 */
export function layoutSidebarView(
  contentWidth: number,
  contentHeight: number,
  options?: LayoutOptions,
): ViewBounds {
  const isVisible = options?.sidebarVisible ?? false;
  const width = options?.sidebarWidth ?? SIDEBAR_WIDTH;
  const position = options?.sidebarPosition ?? 'right';
  const effectiveWidth = isVisible ? Math.max(0, width) : 0;
  const availHeight = Math.max(0, contentHeight - TITLEBAR_HEIGHT);

  if (!isVisible || effectiveWidth === 0) {
    return {
      x: position === 'left' ? 0 : Math.max(0, contentWidth),
      y: TITLEBAR_HEIGHT,
      width: 0,
      height: availHeight,
    };
  }

  if (position === 'left') {
    return {
      x: 0,
      y: TITLEBAR_HEIGHT,
      width: effectiveWidth,
      height: availHeight,
    };
  }

  return {
    x: Math.max(0, contentWidth - effectiveWidth),
    y: TITLEBAR_HEIGHT,
    width: effectiveWidth,
    height: availHeight,
  };
}
