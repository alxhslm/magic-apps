import { describe, it, expect } from 'vitest';
import {
  CALENDAR_MIN_HEIGHT,
  CALENDAR_MIN_WIDTH,
  layoutCalendarView,
  layoutSidebarView,
  SIDEBAR_WIDTH,
  windowMinWidth,
} from '../src/window-layout.js';
import { TITLEBAR_HEIGHT } from '../src/constants.js';

describe('layoutCalendarView', () => {
  it('insets the view below the traffic lights', () => {
    const bounds = layoutCalendarView(1280, 820);
    expect(bounds).toEqual({
      x: 0,
      y: TITLEBAR_HEIGHT,
      width: 1280,
      height: 820 - TITLEBAR_HEIGHT,
    });
  });

  it('adjusts width when sidebar is visible on the right', () => {
    const bounds = layoutCalendarView(1280, 820, { sidebarVisible: true });
    expect(bounds).toEqual({
      x: 0,
      y: TITLEBAR_HEIGHT,
      width: 1280 - SIDEBAR_WIDTH,
      height: 820 - TITLEBAR_HEIGHT,
    });
  });

  it('adjusts x offset when sidebar is visible on the left', () => {
    const bounds = layoutCalendarView(1280, 820, { sidebarVisible: true, sidebarPosition: 'left' });
    expect(bounds).toEqual({
      x: SIDEBAR_WIDTH,
      y: TITLEBAR_HEIGHT,
      width: 1280 - SIDEBAR_WIDTH,
      height: 820 - TITLEBAR_HEIGHT,
    });
  });

  it('never reports a negative height for a window shorter than the titlebar', () => {
    expect(layoutCalendarView(400, 10).height).toBe(0);
  });

  it('never reports a negative width', () => {
    expect(layoutCalendarView(-5, 500).width).toBe(0);
  });
});

describe('layoutSidebarView', () => {
  it('returns zero width when sidebar is not visible', () => {
    const bounds = layoutSidebarView(1280, 820, { sidebarVisible: false });
    expect(bounds.width).toBe(0);
    expect(bounds.height).toBe(820 - TITLEBAR_HEIGHT);
  });

  it('positions sidebar on the right when visible', () => {
    const bounds = layoutSidebarView(1280, 820, { sidebarVisible: true, sidebarPosition: 'right' });
    expect(bounds).toEqual({
      x: 1280 - SIDEBAR_WIDTH,
      y: TITLEBAR_HEIGHT,
      width: SIDEBAR_WIDTH,
      height: 820 - TITLEBAR_HEIGHT,
    });
  });

  it('positions sidebar on the left when specified', () => {
    const bounds = layoutSidebarView(1280, 820, { sidebarVisible: true, sidebarPosition: 'left' });
    expect(bounds).toEqual({
      x: 0,
      y: TITLEBAR_HEIGHT,
      width: SIDEBAR_WIDTH,
      height: 820 - TITLEBAR_HEIGHT,
    });
  });
});

describe('windowMinWidth', () => {
  it('returns CALENDAR_MIN_WIDTH when sidebar is not visible', () => {
    expect(windowMinWidth(false)).toBe(CALENDAR_MIN_WIDTH);
    expect(CALENDAR_MIN_WIDTH).toBe(1280);
    expect(CALENDAR_MIN_HEIGHT).toBe(600);
  });

  it('adds sidebar width when sidebar is visible', () => {
    expect(windowMinWidth(true)).toBe(CALENDAR_MIN_WIDTH + SIDEBAR_WIDTH);
    expect(windowMinWidth(true)).toBe(1560);
    expect(windowMinWidth(true, 300)).toBe(CALENDAR_MIN_WIDTH + 300);
  });
});
