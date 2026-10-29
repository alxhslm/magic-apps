import { describe, it, expect } from 'vitest';
import { chooseReloadRecovery, RECREATE_WINDOW_WITHIN_MS } from '../src/reload-recovery.js';

describe('choosing how a reload recovers the window', () => {
  it('rebuilds the view for the first request in a window', () => {
    expect(chooseReloadRecovery(undefined, 1_000)).toBe('view');
  });

  it('rebuilds the window when a request follows one that changed nothing', () => {
    expect(chooseReloadRecovery(1_000, 1_100)).toBe('window');
  });

  it('rebuilds the view again once the previous request is old', () => {
    const now = 1_000 + RECREATE_WINDOW_WITHIN_MS;
    expect(chooseReloadRecovery(1_000, now)).toBe('view');
  });

  it('still rebuilds the window at the edge of the repeat window', () => {
    const now = 1_000 + RECREATE_WINDOW_WITHIN_MS - 1;
    expect(chooseReloadRecovery(1_000, now)).toBe('window');
  });
});
