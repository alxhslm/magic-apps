import { describe, it, expect } from 'vitest';
import { layoutCalendarView } from '../src/window-layout.js';
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

  it('never reports a negative height for a window shorter than the titlebar', () => {
    expect(layoutCalendarView(400, 10).height).toBe(0);
  });

  it('never reports a negative width', () => {
    expect(layoutCalendarView(-5, 500).width).toBe(0);
  });
});
