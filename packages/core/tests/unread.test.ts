import { describe, it, expect } from 'vitest';
import { formatDockBadge } from '../src/unread.js';

describe('formatDockBadge', () => {
  it('formats positive integers correctly', () => {
    expect(formatDockBadge(5)).toBe('5');
    expect(formatDockBadge(42)).toBe('42');
  });

  it('formats large counts with 999+', () => {
    expect(formatDockBadge(1000)).toBe('999+');
    expect(formatDockBadge(9999)).toBe('999+');
  });

  it('returns empty string for 0 or negative counts', () => {
    expect(formatDockBadge(0)).toBe('');
    expect(formatDockBadge(-5)).toBe('');
  });
});

describe('formatDockBadge — at least', () => {
  it('appends a plus when the count may be short of the truth', () => {
    expect(formatDockBadge(12, true)).toBe('12+');
  });

  it('stays blank at zero, since there is nothing to point at', () => {
    expect(formatDockBadge(0, true)).toBe('');
  });

  it('does not double the plus at the top end', () => {
    expect(formatDockBadge(5000, true)).toBe('999+');
  });
});
