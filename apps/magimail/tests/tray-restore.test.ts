import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTray,
  updateTrayData,
  restoreTray,
  destroyTray,
  isTrayCreated,
} from '../src/menubar-manager.js';
import { sendToHelper, isHelperRunning } from '../src/swift-helper.js';
import type { AccountConfig } from '@magimail/core';

vi.mock('../src/swift-helper.js', () => ({
  sendToHelper: vi.fn(),
  isHelperRunning: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn().mockReturnValue({ menuBarShowCount: true, menuBarShowDots: true }),
}));

const accounts = [
  { id: 'work', name: 'Work', color: '#3b82f6', unreadCount: 4, partition: 'persist:work' },
] as unknown as AccountConfig[];

describe('Menu bar item survives a helper respawn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isHelperRunning).mockReturnValue(true);
    destroyTray();
    vi.clearAllMocks();
  });

  it('re-creates the status item and re-sends the counts', () => {
    createTray();
    updateTrayData(accounts, 4);
    vi.clearAllMocks();

    // The helper has been replaced. `trayCreated` is still true, so
    // `createTray()` would early-return and leave the new helper with nothing.
    restoreTray();

    expect(sendToHelper).toHaveBeenCalledWith('tray.create');
    expect(sendToHelper).toHaveBeenCalledWith(
      'tray.update',
      expect.objectContaining({
        totalUnread: 4,
        accounts: [expect.objectContaining({ id: 'work', unreadCount: 4 })],
      }),
    );
  });

  it('restores the counts from before the respawn, not an empty tray', () => {
    // The point of the cache: the replacement item shows the real state at
    // once, rather than zero until the next poll lands.
    createTray();
    updateTrayData(accounts, 7);
    vi.clearAllMocks();

    restoreTray();

    const update = vi.mocked(sendToHelper).mock.calls.find(([method]) => method === 'tray.update');
    expect(update?.[1]).toMatchObject({ totalUnread: 7 });
  });

  it('does nothing when the user has the menu bar item switched off', () => {
    // No status item was ever asked for, so a respawn must not conjure one.
    expect(isTrayCreated()).toBe(false);

    restoreTray();

    expect(sendToHelper).not.toHaveBeenCalled();
  });

  it('does not respawn the helper by trying to restore into a dead one', () => {
    createTray();
    vi.clearAllMocks();
    vi.mocked(isHelperRunning).mockReturnValue(false);

    restoreTray();

    // `sendToHelper` respawns on demand, which would re-enter this very
    // callback. The guard is what keeps a restore from looping.
    expect(sendToHelper).not.toHaveBeenCalled();
  });

  /**
   * Offline is pushed by whichever path noticed it -- a renderer's `offline`
   * event, or a poll that failed once every renderer was suspended. Every
   * *other* `tray.update` (a poll result, a rename, a focus filter change)
   * knows nothing about the connection and must not clear the banner.
   */
  it('keeps the offline flag across updates that do not mention it', () => {
    createTray();
    updateTrayData(accounts, 4, { isOffline: true });
    vi.clearAllMocks();

    updateTrayData(accounts, 4);
    expect(sendToHelper).toHaveBeenCalledWith(
      'tray.update',
      expect.objectContaining({ isOffline: true }),
    );

    // A replacement helper inherits it too, rather than showing a stale list
    // with nothing to explain why it is stale.
    vi.clearAllMocks();
    restoreTray();
    expect(sendToHelper).toHaveBeenCalledWith(
      'tray.update',
      expect.objectContaining({ isOffline: true }),
    );

    // Coming back online is the one thing that clears it.
    vi.clearAllMocks();
    updateTrayData(accounts, 4, { isOffline: false });
    expect(sendToHelper).toHaveBeenCalledWith(
      'tray.update',
      expect.objectContaining({ isOffline: false }),
    );
  });

  describe('retry behaviour on helper RPC failure', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('schedules a retry after a dropped tray.update payload', async () => {
      vi.mocked(sendToHelper).mockResolvedValueOnce('ok').mockResolvedValueOnce(null);
      createTray();
      updateTrayData(accounts, 4);

      await vi.waitFor(() => {
        expect(sendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));
      });

      const callsBeforeRetry = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([method]) => method === 'tray.update').length;

      vi.mocked(sendToHelper).mockResolvedValueOnce('ok');
      await vi.advanceTimersByTimeAsync(1000);

      const callsAfterRetry = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([method]) => method === 'tray.update').length;
      expect(callsAfterRetry).toBe(callsBeforeRetry + 1);
    });

    it('does not retry infinitely if the retry also fails', async () => {
      vi.mocked(sendToHelper).mockImplementation((method) =>
        method === 'tray.create' ? Promise.resolve('ok') : Promise.resolve(null),
      );
      createTray();
      updateTrayData(accounts, 4);

      await vi.waitFor(() => {
        expect(sendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));
      });

      await vi.advanceTimersByTimeAsync(1000);
      const callsAfterFirstRetry = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([method]) => method === 'tray.update').length;

      await vi.advanceTimersByTimeAsync(5000);
      const callsLater = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([method]) => method === 'tray.update').length;
      expect(callsLater).toBe(callsAfterFirstRetry);
    });

    it('cancels pending retry when destroyed', async () => {
      vi.mocked(sendToHelper).mockResolvedValue(null);
      createTray();
      updateTrayData(accounts, 4);

      await vi.waitFor(() => {
        expect(sendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));
      });

      destroyTray();
      const callsAtDestroy = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([method]) => method === 'tray.update').length;

      await vi.advanceTimersByTimeAsync(2000);
      const callsLater = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([method]) => method === 'tray.update').length;
      expect(callsLater).toBe(callsAtDestroy);
    });
  });
});
