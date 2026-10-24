import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DiagnosticBundleResult } from '@magimail/core';

const { showMessageBox } = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
}));

const { showItemInFolder, openExternal } = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
  openExternal: vi.fn(),
}));

const { syncExtensionLogs } = vi.hoisted(() => ({
  syncExtensionLogs: vi.fn(),
}));

const { isHelperRunning, getHelperPid } = vi.hoisted(() => ({
  isHelperRunning: vi.fn().mockReturnValue(true),
  getHelperPid: vi.fn().mockReturnValue(1234),
}));

const { isTrayCreated } = vi.hoisted(() => ({
  isTrayCreated: vi.fn().mockReturnValue(true),
}));

const { collectDiagnosticBundle } = vi.hoisted(() => ({
  collectDiagnosticBundle: vi.fn(),
}));

const { writeText } = vi.hoisted(() => ({
  writeText: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getPath: () => '/fake/downloads',
  },
  dialog: { showMessageBox },
  shell: { showItemInFolder, openExternal },
  clipboard: { writeText },
}));

vi.mock('@magimail/core/logger', () => ({
  logDirectory: () => '/fake/logs',
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../src/extension-logs.js', () => ({ syncExtensionLogs }));
vi.mock('../src/swift-helper.js', () => ({ isHelperRunning, getHelperPid }));
vi.mock('../src/menubar-manager.js', () => ({ isTrayCreated }));
vi.mock('@magimail/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@magimail/core')>();
  return {
    ...actual,
    collectDiagnosticBundle,
  };
});

const { collectMagimailDiagnostics, presentDiagnosticsDialog, handleCollectDiagnostics } =
  await import('../src/diagnostics.js');

describe('Magimail Diagnostics', () => {
  const fakeResult: DiagnosticBundleResult = {
    archivePath: '/fake/downloads/Magimail-Diagnostics-20261002.zip',
    archiveName: 'Magimail-Diagnostics-20261002.zip',
    files: ['main.log', 'diagnostics.json'],
    summaryText: 'App: Magimail 1.0.0\nmacOS 15.6.1',
    environment: {
      app: { name: 'Magimail', version: '1.0.0' },
      os: {
        platform: 'darwin',
        release: '24.6.0',
        version: '15.6.1',
        build: '24G90',
        arch: 'arm64',
      },
      versions: { app: '1.0.0', electron: '44.1.1', chrome: '152.0.7977.65', node: '22.13.5' },
      hardware: {
        totalMemoryMB: 16384,
        freeMemoryMB: 8192,
        systemUptimeHours: 10,
        processUptimeMinutes: 5,
        memoryUsageMB: { rss: 100, heapTotal: 50, heapUsed: 30, external: 5 },
      },
      generatedAt: '2026-10-02T10:00:00.000Z',
      files: ['main.log'],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('collectMagimailDiagnostics', () => {
    it('syncs extension logs and invokes collectDiagnosticBundle with state', async () => {
      collectDiagnosticBundle.mockResolvedValueOnce(fakeResult);

      const fakeAccountsManager = {
        getAccounts: () => [{ id: 'acc_1', name: 'Work' }],
        getActiveAccount: () => ({ id: 'acc_1', name: 'Work' }),
      } as unknown as Parameters<typeof collectMagimailDiagnostics>[0];

      const fakePollers = new Map([
        [
          'acc_1',
          { getArrivalCount: () => 5 } as unknown as Parameters<
            typeof collectMagimailDiagnostics
          >[1] extends Map<string, infer P> | undefined
            ? P
            : never,
        ],
      ]);

      const result = await collectMagimailDiagnostics(fakeAccountsManager, fakePollers);

      expect(syncExtensionLogs).toHaveBeenCalledWith('/fake/logs');
      expect(collectDiagnosticBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          appName: 'Magimail',
          appVersion: '1.0.0',
          logsDir: '/fake/logs',
          state: {
            accountCount: 1,
            activeAccountIndex: 0,
            helper: { running: true, pid: 1234 },
            trayCreated: true,
            pollersCount: 1,
          },
        }),
      );
      expect(result).toBe(fakeResult);
    });
  });

  describe('presentDiagnosticsDialog', () => {
    it('reveals archive and copies summary when button 0 (Reveal in Finder) is clicked', async () => {
      showMessageBox.mockResolvedValueOnce({ response: 0 });

      await presentDiagnosticsDialog(undefined, fakeResult);

      expect(showMessageBox).toHaveBeenCalledTimes(1);
      expect(writeText).toHaveBeenCalledWith(fakeResult.summaryText);
      expect(showItemInFolder).toHaveBeenCalledWith(fakeResult.archivePath);
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('copies summary and does not open Finder or external URL when button 1 (Copy) is clicked', async () => {
      showMessageBox.mockResolvedValueOnce({ response: 1 });

      await presentDiagnosticsDialog(undefined, fakeResult);

      expect(writeText).toHaveBeenCalledWith(fakeResult.summaryText);
      expect(showItemInFolder).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('opens GitHub issue url and reveals archive when button 2 (GitHub) is clicked', async () => {
      showMessageBox.mockResolvedValueOnce({ response: 2 });

      await presentDiagnosticsDialog(undefined, fakeResult);

      expect(writeText).toHaveBeenCalledWith(fakeResult.summaryText);
      expect(showItemInFolder).toHaveBeenCalledWith(fakeResult.archivePath);
      expect(openExternal).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/alxhslm/magic-apps/issues/new?title='),
      );
    });

    it('opens mailto: draft and reveals archive when button 3 (Email) is clicked', async () => {
      showMessageBox.mockResolvedValueOnce({ response: 3 });

      await presentDiagnosticsDialog(undefined, fakeResult);

      expect(writeText).toHaveBeenCalledWith(fakeResult.summaryText);
      expect(showItemInFolder).toHaveBeenCalledWith(fakeResult.archivePath);
      expect(openExternal).toHaveBeenCalledWith(
        expect.stringContaining('mailto:support@macmagic.app?subject='),
      );
    });

    it('does nothing when button 4 (Done) is clicked', async () => {
      showMessageBox.mockResolvedValueOnce({ response: 4 });

      await presentDiagnosticsDialog(undefined, fakeResult);

      expect(showItemInFolder).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    });
  });

  describe('handleCollectDiagnostics', () => {
    it('runs collection and presents the dialog', async () => {
      collectDiagnosticBundle.mockResolvedValueOnce(fakeResult);
      showMessageBox.mockResolvedValueOnce({ response: 3 });

      await handleCollectDiagnostics(undefined);

      expect(collectDiagnosticBundle).toHaveBeenCalledTimes(1);
      expect(showMessageBox).toHaveBeenCalledTimes(1);
    });

    it('catches collection failures and shows error dialog', async () => {
      collectDiagnosticBundle.mockRejectedValueOnce(new Error('Disk full'));

      await handleCollectDiagnostics(undefined);

      expect(showMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'error',
          title: 'Diagnostics Error',
          detail: 'Disk full',
        }),
      );
    });
  });
});
