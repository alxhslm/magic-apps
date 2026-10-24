import { describe, it, expect, beforeEach } from 'vitest';
import { updateDockBadge, getCurrentBadgeCount } from '../src/dock.js';

describe('Magimail Dock Management', () => {
  beforeEach(() => {
    updateDockBadge(0);
  });

  it('initializes badge count at 0', () => {
    expect(getCurrentBadgeCount()).toBe(0);
  });

  it('updates current badge count on positive input', () => {
    updateDockBadge(7);
    expect(getCurrentBadgeCount()).toBe(7);
  });

  it('clamps negative badge count to 0', () => {
    updateDockBadge(-3);
    expect(getCurrentBadgeCount()).toBe(0);
  });
});
