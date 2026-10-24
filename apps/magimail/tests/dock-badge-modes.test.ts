import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

/**
 * What each badge mode actually paints.
 *
 * The counts are settled long before this point, so these assertions are about
 * the last step only: which number the mode picks, and whether it is rendered
 * as a total or as a floor. That step had no coverage, and it is the one where
 * a wrong call silently drops the `+` and turns an honest floor into a claim.
 */
/**
 * The dock is macOS-only and `repaint()` returns early anywhere else, so CI —
 * which is not macOS — would watch every assertion pass on a spy that was never
 * called. Pinned for the file, as `login-item.test.ts` and `menu.test.ts` do.
 */
const realPlatform = process.platform;
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

const setBadge = vi.fn();

vi.mock('electron', () => ({
  app: { dock: { setBadge: (value: string) => setBadge(value) } },
}));

let mode = 'allUnread';
vi.mock('../src/settings-store.js', () => ({
  loadSettings: () => ({ dockBadgeMode: mode }),
}));

const { updateDockBadge } = await import('../src/dock.js');

describe('dock badge modes', () => {
  beforeEach(() => {
    setBadge.mockClear();
  });

  it('shows the unread total in all-unread mode, ignoring arrivals', () => {
    mode = 'allUnread';
    updateDockBadge(42, { count: 3, incomplete: true });
    expect(setBadge).toHaveBeenLastCalledWith('42');
  });

  it('shows the arrival count in new-arrivals mode, ignoring the backlog', () => {
    mode = 'newArrivals';
    updateDockBadge(4000, { count: 3, incomplete: false });
    expect(setBadge).toHaveBeenLastCalledWith('3');
  });

  it('marks the arrival count as a floor when the feed was cut short', () => {
    mode = 'newArrivals';
    updateDockBadge(4000, { count: 3, incomplete: true });
    expect(setBadge).toHaveBeenLastCalledWith('3+');
  });

  it('never marks the unread total as a floor — it is the feed total already', () => {
    mode = 'allUnread';
    updateDockBadge(4000, { count: 3, incomplete: true });
    expect(setBadge).toHaveBeenLastCalledWith('999+');
  });

  it('paints nothing when the badge is off, whatever is waiting', () => {
    mode = 'off';
    updateDockBadge(42, { count: 3, incomplete: true });
    expect(setBadge).toHaveBeenLastCalledWith('');
  });

  it('keeps the last arrival state when a caller reports only the unread total', () => {
    mode = 'newArrivals';
    updateDockBadge(10, { count: 7, incomplete: true });
    updateDockBadge(11);
    expect(setBadge).toHaveBeenLastCalledWith('7+');
  });
});
