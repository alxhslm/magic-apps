import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Stands in for the OS temp directory, so a share really writes and really cleans up. */
let tempRoot = '';

// Mock native toolbar and sharing picker
vi.mock('../src/native-toolbar.js', () => ({
  attachNativeToolbar: vi.fn(),
  updateNativeToolbarAccounts: vi.fn(),
  setNativeToolbarItemEnabled: vi.fn(),
  setNativeToolbarShareUrl: vi.fn(),
  showNativeSharingPicker: vi.fn(),
}));

// Mock @magimail/core
vi.mock('@magimail/core', async () => {
  const actual = await vi.importActual<typeof import('@magimail/core')>('@magimail/core');
  return {
    ...actual,
    configureGoogleSession: vi.fn(),
    injectGmailStyles: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock Electron components
vi.mock('electron', () => {
  const createMockWebContents = () => ({
    loadURL: vi.fn().mockResolvedValue(undefined),
    loadFile: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
    isLoading: vi.fn().mockReturnValue(false),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    sendInputEvent: vi.fn(),
    insertCSS: vi.fn().mockResolvedValue(''),
    isDestroyed: vi.fn().mockReturnValue(false),
    executeJavaScript: vi.fn().mockResolvedValue(false),
    getURL: vi.fn().mockReturnValue('https://mail.google.com/mail/u/0/#inbox'),
    getTitle: vi.fn().mockReturnValue('Test Subject'),
    mainFrame: { frames: [] },
    print: vi.fn(),
    printToPDF: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock content')),
  });

  class MockWebContentsView {
    webContents = createMockWebContents();
    setBounds = vi.fn();
    setBackgroundColor = vi.fn();
  }

  const mockChildren: unknown[] = [];
  const mockContentView = {
    children: mockChildren,
    addChildView: vi.fn((view: unknown) => mockChildren.push(view)),
    removeChildView: vi.fn((view: unknown) => {
      const idx = mockChildren.indexOf(view);
      if (idx >= 0) mockChildren.splice(idx, 1);
    }),
  };

  class MockBrowserWindow {
    show = vi.fn();
    focus = vi.fn();
    destroy = vi.fn();
    loadURL = vi.fn().mockResolvedValue(undefined);
    contentView = mockContentView;
    webContents = createMockWebContents();
    on = vi.fn();
    getContentSize = vi.fn().mockReturnValue([1200, 800]);
    getNativeWindowHandle = vi.fn().mockReturnValue(Buffer.alloc(8));
  }

  return {
    BaseWindow: MockBrowserWindow,
    BrowserWindow: MockBrowserWindow,
    WebContentsView: MockWebContentsView,
    webFrameMain: { fromId: vi.fn() },
    dialog: {
      showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
      showSaveDialog: vi.fn().mockResolvedValue({ canceled: false, filePath: '/tmp/test.pdf' }),
    },
    clipboard: {
      writeText: vi.fn(),
    },
    session: {
      fromPartition: vi.fn().mockReturnValue({
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn() },
      }),
      defaultSession: {
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn() },
      },
    },
    app: {
      name: 'Magimail',
      getPath: vi.fn(() => tempRoot),
    },
  };
});

import { AccountsManager } from '../src/accounts-manager.js';
import { setNativeToolbarItemEnabled, showNativeSharingPicker } from '../src/native-toolbar.js';
import { BaseWindow, dialog, clipboard } from 'electron';

describe('Outbound Sharing & Authentic Print Logic', () => {
  let accountsManager: AccountsManager;
  let mockWin: BaseWindow;

  beforeEach(() => {
    vi.clearAllMocks();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-sharing-test-'));
    mockWin = new BaseWindow();
    accountsManager = new AccountsManager(mockWin, '/mock/preload.js');
    accountsManager.initialize();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe('Thread Detection', () => {
    it('synchronously identifies thread URLs from hash patterns', () => {
      // Thread routes
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#sent/FMfcgzGxT123456789',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#all/1800000000000001'),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#starred/1800000000000001',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#snoozed/1800000000000001',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#trash/1800000000000001',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#spam/1800000000000001'),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#drafts/1800000000000001',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#imp/1800000000000001'),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#category/social/1800000000000001',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#category~updates/1800000000000001',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#label/Work/1800000000000001',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#label/Work%2FProjects/1800000000000001',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync(
          'https://mail.google.com/mail/u/0/#search/budget/1800000000000001',
        ),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#thread-f:182390192301'),
      ).toBe(true);
      expect(
        accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#thread-a:182390192301'),
      ).toBe(true);

      // List views (should return false)
      expect(accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#inbox')).toBe(
        false,
      );
      expect(accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#sent')).toBe(
        false,
      );
      expect(accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#all')).toBe(false);
      expect(accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#label/Work')).toBe(
        false,
      );
      expect(
        accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#search/budget'),
      ).toBe(false);
      expect(
        accountsManager.isThreadOpenSync('https://mail.google.com/mail/u/0/#category/social'),
      ).toBe(false);
      expect(accountsManager.isThreadOpenSync('https://accounts.google.com/ServiceLogin')).toBe(
        false,
      );
    });

    it('reliably returns false on inbox list view without invoking DOM execution', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox',
      );

      expect(await accountsManager.isThreadOpen()).toBe(false);
      expect(activeView?.webContents.executeJavaScript).not.toHaveBeenCalled();
    });

    it('reliably returns true when thread URL is active', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );

      expect(await accountsManager.isThreadOpen()).toBe(true);
      expect(activeView?.webContents.executeJavaScript).not.toHaveBeenCalled();
    });

    it('updates toolbar action state (print and share buttons enabled/disabled)', () => {
      accountsManager.updateToolbarActionState(true);
      expect(setNativeToolbarItemEnabled).toHaveBeenCalledWith('print', true);
      expect(setNativeToolbarItemEnabled).toHaveBeenCalledWith('share', true);

      accountsManager.updateToolbarActionState(false);
      expect(setNativeToolbarItemEnabled).toHaveBeenCalledWith('print', false);
      expect(setNativeToolbarItemEnabled).toHaveBeenCalledWith('share', false);
    });
  });

  describe('Subject Sanitization and Thread Info', () => {
    it('retrieves and sanitizes thread subject from active view', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(
        'Re: Q3 Budget & Review / Design [FINAL]?',
      );

      const subject = await accountsManager.getThreadSubject();
      expect(subject).toBe('Re: Q3 Budget & Review / Design [FINAL]?');
    });

    it('resolves the subject in order and never falls back to a minified class', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      let script = '';
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockImplementationOnce(
        (code: string) => {
          script = code;
          return Promise.resolve('Subject');
        },
      );

      await accountsManager.getThreadSubject();

      expect(script).toContain('resolveOrdered');
      expect(script).toContain('h2[data-thread-perm-id]');
      expect(script).not.toContain('h2.hP');
    });

    it('handles null/empty subject by falling back to Email', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(null);

      const subject = await accountsManager.getThreadSubject();
      expect(subject).toBe('Email');
    });
  });

  describe('Authentic Print URL Resolution', () => {
    it('constructs print URL from thread permalink URL', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#thread-f:182390192301',
      );

      const printUrl = await accountsManager.getAuthenticPrintUrl();
      expect(printUrl).toBe(
        'https://mail.google.com/mail/u/0/?view=pt&search=all&permthid=thread-f%3A182390192301',
      );
    });

    it('constructs print URL from legacy hex thread identifier in URL hash and derives /u/0/', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/1/#inbox/1800000000000001',
      );

      const printUrl = await accountsManager.getAuthenticPrintUrl();
      expect(printUrl).toBe(
        'https://mail.google.com/mail/u/0/?view=pt&search=all&th=1800000000000001',
      );
    });

    it('resolves authentic print URL from DOM thread affordance permthid', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
      );
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValueOnce({
        permthid: 'thread-f:182390192301',
      });

      const printUrl = await accountsManager.getAuthenticPrintUrl();
      expect(printUrl).toBe(
        'https://mail.google.com/mail/u/0/?view=pt&search=all&permthid=thread-f%3A182390192301',
      );
    });

    it('resolves authentic print URL from DOM legacy thread id affordance', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
      );
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValueOnce({
        th: '1800000000000001',
      });

      const printUrl = await accountsManager.getAuthenticPrintUrl();
      expect(printUrl).toBe(
        'https://mail.google.com/mail/u/0/?view=pt&search=all&th=1800000000000001',
      );
    });

    it('returns null for modern FMfcgz... route when DOM has no identifier to avoid broken th= URLs', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/FMfcgzGxT123456789',
      );
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValueOnce(null);

      const printUrl = await accountsManager.getAuthenticPrintUrl();
      expect(printUrl).toBeNull();
    });

    it('derives /u/0/ from account partition regardless of index in current view URL', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/2/#thread-f:182390192301',
      );

      const printUrl = await accountsManager.getAuthenticPrintUrl();
      expect(printUrl).toBe(
        'https://mail.google.com/mail/u/0/?view=pt&search=all&permthid=thread-f%3A182390192301',
      );
    });

    it('returns null on inbox list view', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox',
      );

      const printUrl = await accountsManager.getAuthenticPrintUrl();
      expect(printUrl).toBeNull();
    });
  });

  describe('Export Active Thread to PDF', () => {
    it('cancels export if user cancels the save dialog', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );
      (dialog.showSaveDialog as unknown as Mock).mockResolvedValueOnce({
        canceled: true,
        filePath: undefined,
      });

      await accountsManager.exportActiveThreadToPdf();
      expect(dialog.showSaveDialog).toHaveBeenCalled();
      expect(activeView?.webContents.printToPDF).not.toHaveBeenCalled();
    });

    it('generates authentic PDF buffer and writes to file when save dialog confirmed', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(
        'Quarterly Report',
      );

      const testSavePath = '/tmp/magimail-test-save.pdf';
      (dialog.showSaveDialog as unknown as Mock).mockResolvedValueOnce({
        canceled: false,
        filePath: testSavePath,
      });

      const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValueOnce(undefined);

      await accountsManager.exportActiveThreadToPdf();
      expect(dialog.showSaveDialog).toHaveBeenCalledWith(
        mockWin,
        expect.objectContaining({
          title: 'Export as PDF',
          defaultPath: 'Quarterly Report.pdf',
        }),
      );
      expect(writeFileSpy).toHaveBeenCalledWith(testSavePath, expect.any(Buffer));
      writeFileSpy.mockRestore();
    });

    it('falls back to live view printToPDF when print window lands on "Conversation deleted" stub', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(
        'Important Thread',
      );

      // Save dialog proceeds
      const testSavePath = '/tmp/magimail-fallback-deleted.pdf';
      (dialog.showSaveDialog as unknown as Mock).mockResolvedValueOnce({
        canceled: false,
        filePath: testSavePath,
      });

      // Spy on createPrintWindow to simulate it detecting deleted conversation and returning null
      const createPrintWinSpy = vi
        .spyOn(accountsManager, 'createPrintWindow')
        .mockResolvedValueOnce(null);
      const printToPdfSpy = vi.spyOn(activeView!.webContents, 'printToPDF');
      const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValueOnce(undefined);

      await accountsManager.exportActiveThreadToPdf();

      expect(createPrintWinSpy).toHaveBeenCalled();
      expect(printToPdfSpy).toHaveBeenCalledWith({ printBackground: true });
      expect(writeFileSpy).toHaveBeenCalledWith(testSavePath, expect.any(Buffer));

      createPrintWinSpy.mockRestore();
      printToPdfSpy.mockRestore();
      writeFileSpy.mockRestore();
    });

    it('falls back to live view print in printActiveView when print window cannot be created or is invalid', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );

      const createPrintWinSpy = vi
        .spyOn(accountsManager, 'createPrintWindow')
        .mockResolvedValueOnce(null);
      const printSpy = vi.spyOn(activeView!.webContents, 'print');

      await accountsManager.printActiveView();

      expect(createPrintWinSpy).toHaveBeenCalled();
      expect(printSpy).toHaveBeenCalledWith(
        { silent: false, printBackground: true },
        expect.any(Function),
      );

      createPrintWinSpy.mockRestore();
      printSpy.mockRestore();
    });
  });

  describe('Share Actions', () => {
    it('copies thread permalink to clipboard', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );

      await accountsManager.copyActiveThreadLink();
      expect(clipboard.writeText).toHaveBeenCalledWith(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );
    });

    it('invokes native sharing picker with thread URL', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );

      await accountsManager.shareActiveThreadLink();
      expect(showNativeSharingPicker).toHaveBeenCalledWith(mockWin, [
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      ]);
    });

    it('invokes native sharing picker with generated PDF file path', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(
        'Important Doc',
      );

      await accountsManager.shareActiveThreadAsPdf();
      expect(showNativeSharingPicker).toHaveBeenCalledWith(
        mockWin,
        expect.arrayContaining([expect.stringMatching(/Important Doc\.pdf$/)]),
        expect.any(Function),
      );
    });

    it('removes the exported PDF once the sharing service has finished with it', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox/1800000000000001',
      );
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(
        'Important Doc',
      );

      await accountsManager.shareActiveThreadAsPdf();

      const [, items, onFinished] = (showNativeSharingPicker as unknown as Mock).mock.calls.at(
        -1,
      ) as [unknown, string[], () => void];
      expect(fs.existsSync(items[0])).toBe(true);

      onFinished();
      expect(fs.existsSync(path.dirname(items[0]))).toBe(false);
    });

    it('shows notification dialog when attempting to share while on inbox list view', async () => {
      const activeView = accountsManager.getActiveWebContentsView();
      (activeView?.webContents.getURL as unknown as Mock).mockReturnValue(
        'https://mail.google.com/mail/u/0/#inbox',
      );
      (activeView?.webContents.executeJavaScript as unknown as Mock).mockResolvedValue(false);

      await accountsManager.copyActiveThreadLink();
      expect(dialog.showMessageBox).toHaveBeenCalledWith(
        mockWin,
        expect.objectContaining({
          type: 'info',
          title: 'No Email Selected',
        }),
      );
      expect(clipboard.writeText).not.toHaveBeenCalled();

      await accountsManager.shareActiveThreadLink();
      expect(showNativeSharingPicker).not.toHaveBeenCalled();

      await accountsManager.shareActiveThreadAsPdf();
      expect(showNativeSharingPicker).not.toHaveBeenCalled();
    });
  });
});
