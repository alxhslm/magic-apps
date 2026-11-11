import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTray,
  updateTrayData,
  updateVerificationCode,
  restoreTray,
  destroyTray,
} from '../src/menubar-manager.js';
import { sendToHelper, isHelperRunning } from '../src/swift-helper.js';
import { loadSettings } from '../src/settings-store.js';
import type { AccountConfig } from '@magimail/core';
import type { VerificationCodeItem } from '../src/mailbox/types.js';

vi.mock('../src/swift-helper.js', () => ({
  sendToHelper: vi.fn(),
  isHelperRunning: vi.fn().mockReturnValue(true),
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn().mockReturnValue({ menuBarUnreadDisplay: 'numbers' }),
}));

const accounts: AccountConfig[] = [
  { id: 'work', name: 'Work', color: '#3b82f6', unreadCount: 2, partition: 'persist:work' },
] as unknown as AccountConfig[];

const sampleCode: VerificationCodeItem = {
  code: '123456',
  service: 'GitHub',
  subject: 'Your verification code',
  from: 'support@github.com',
  messageId: 'msg-1',
  threadId: 'th-1',
  accountId: 'work',
  receivedAt: 1700000000000,
};

describe('Tray update and verification code deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isHelperRunning).mockReturnValue(true);
    vi.mocked(loadSettings).mockReturnValue({ menuBarUnreadDisplay: 'numbers' });
    destroyTray();
    vi.clearAllMocks();
  });

  describe('tray.update deduplication', () => {
    it('skips sending tray.update when the payload has not changed', () => {
      createTray();
      updateTrayData(accounts, 2);

      const callsAfterFirst = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.update').length;
      expect(callsAfterFirst).toBe(1);

      // Subsequent identical poll
      updateTrayData(accounts, 2);
      const callsAfterSecond = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.update').length;
      expect(callsAfterSecond).toBe(callsAfterFirst);
    });

    it('sends tray.update when totalUnread changes', () => {
      createTray();
      updateTrayData(accounts, 2);

      updateTrayData(accounts, 3);
      const updateCalls = vi.mocked(sendToHelper).mock.calls.filter(([m]) => m === 'tray.update');
      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[1][1]).toMatchObject({ totalUnread: 3 });
    });

    it('sends tray.update when account data changes', () => {
      createTray();
      updateTrayData(accounts, 2);

      const updatedAccounts: AccountConfig[] = [
        { id: 'work', name: 'Work', color: '#3b82f6', unreadCount: 3, partition: 'persist:work' },
      ] as unknown as AccountConfig[];

      updateTrayData(updatedAccounts, 3);
      const updateCalls = vi.mocked(sendToHelper).mock.calls.filter(([m]) => m === 'tray.update');
      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[1][1]).toMatchObject({
        accounts: [expect.objectContaining({ unreadCount: 3 })],
      });
    });

    it('sends tray.update when unreadDisplay setting changes', () => {
      createTray();
      updateTrayData(accounts, 2);

      vi.mocked(loadSettings).mockReturnValue({ menuBarUnreadDisplay: 'dots' });
      updateTrayData(accounts, 2);

      const updateCalls = vi.mocked(sendToHelper).mock.calls.filter(([m]) => m === 'tray.update');
      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[1][1]).toMatchObject({ unreadDisplay: 'dots' });
    });

    it('sends tray.update when isOffline or isRestricted options change', () => {
      createTray();
      updateTrayData(accounts, 2, { isOffline: true });
      updateTrayData(accounts, 2, { isOffline: true, isRestricted: true });

      const updateCalls = vi.mocked(sendToHelper).mock.calls.filter(([m]) => m === 'tray.update');
      expect(updateCalls).toHaveLength(2);
      expect(updateCalls[0][1]).toMatchObject({ isOffline: true, isRestricted: false });
      expect(updateCalls[1][1]).toMatchObject({ isOffline: true, isRestricted: true });
    });

    it('re-sends on retry even when the payload is identical', async () => {
      vi.useFakeTimers();
      vi.mocked(sendToHelper).mockResolvedValueOnce('ok').mockResolvedValueOnce(null);
      createTray();
      updateTrayData(accounts, 2);

      await vi.waitFor(() => {
        expect(sendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));
      });

      const callsBeforeRetry = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.update').length;

      vi.mocked(sendToHelper).mockResolvedValueOnce('ok');
      await vi.advanceTimersByTimeAsync(1000);

      const callsAfterRetry = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.update').length;
      expect(callsAfterRetry).toBe(callsBeforeRetry + 1);

      vi.useRealTimers();
    });

    it('clears the cached payload when RPC returns null so next update re-sends', async () => {
      vi.mocked(sendToHelper).mockResolvedValue(null);
      createTray();
      updateTrayData(accounts, 2);

      // Wait for the async RPC handler to observe result === null
      await Promise.resolve();

      // Pushing the same payload again should send because previous send failed
      vi.mocked(sendToHelper).mockResolvedValue('ok');
      updateTrayData(accounts, 2);

      const updateCalls = vi.mocked(sendToHelper).mock.calls.filter(([m]) => m === 'tray.update');
      expect(updateCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('resets cache on destroyTray and send on subsequent createTray', () => {
      createTray();
      updateTrayData(accounts, 2);
      expect(sendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));

      destroyTray();
      vi.clearAllMocks();

      createTray();
      updateTrayData(accounts, 2);
      expect(sendToHelper).toHaveBeenCalledWith('tray.update', expect.any(Object));
    });
  });

  describe('tray.verificationCode deduplication', () => {
    it('dispatches empty payload once when no code is present and skips repeated empty updates', () => {
      createTray();
      updateVerificationCode(null);

      const callsAfterFirst = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.verificationCode').length;
      expect(callsAfterFirst).toBe(1);
      expect(sendToHelper).toHaveBeenCalledWith('tray.verificationCode', {});

      // Repeated empty polls should be skipped
      updateVerificationCode(null);
      updateVerificationCode(null);
      const callsAfterRepeated = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.verificationCode').length;
      expect(callsAfterRepeated).toBe(1);
    });

    it('dispatches when code arrives and skips repeated identical code', () => {
      createTray();
      updateVerificationCode(null);
      expect(sendToHelper).toHaveBeenCalledWith('tray.verificationCode', {});

      updateVerificationCode(sampleCode);
      const callsWithCode = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.verificationCode');
      expect(callsWithCode).toHaveLength(2);
      expect(callsWithCode[1][1]).toMatchObject({ code: '123456', service: 'GitHub' });

      // Repeating identical code is skipped
      updateVerificationCode(sampleCode);
      const callsAfterRepeat = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.verificationCode');
      expect(callsAfterRepeat).toHaveLength(2);
    });

    it('dispatches when code changes or clears', () => {
      createTray();
      updateVerificationCode(sampleCode);

      const differentCode = { ...sampleCode, code: '654321' };
      updateVerificationCode(differentCode);

      const callsAfterChange = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.verificationCode');
      expect(callsAfterChange).toHaveLength(2);
      expect(callsAfterChange[1][1]).toMatchObject({ code: '654321' });

      // Clear code
      updateVerificationCode(null);
      const callsAfterClear = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.verificationCode');
      expect(callsAfterClear).toHaveLength(3);
      expect(callsAfterClear[2][1]).toEqual({});
    });

    it('clears verification code cache when RPC returns null so next update re-sends', async () => {
      vi.mocked(sendToHelper).mockResolvedValue(null);
      createTray();
      updateVerificationCode(sampleCode);

      await Promise.resolve();

      vi.mocked(sendToHelper).mockResolvedValue('ok');
      updateVerificationCode(sampleCode);

      const codeCalls = vi
        .mocked(sendToHelper)
        .mock.calls.filter(([m]) => m === 'tray.verificationCode');
      expect(codeCalls).toHaveLength(2);
    });

    it('re-sends verification code on restoreTray', () => {
      createTray();
      updateVerificationCode(sampleCode);
      vi.clearAllMocks();

      restoreTray();
      expect(sendToHelper).toHaveBeenCalledWith(
        'tray.verificationCode',
        expect.objectContaining({ code: '123456' }),
      );
    });
  });
});
