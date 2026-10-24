import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleShareUrl } from '../src/share-handler.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Stands in for the OS temp directory, so the suite's own staging is cleaned up. */
let tempRoot = '';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tempRoot),
    focus: vi.fn(),
  },
  BaseWindow: vi.fn(),
  BrowserWindow: vi.fn(),
}));

vi.mock('../src/native-toolbar.js', () => ({
  nativeDropFiles: vi.fn(),
}));

vi.mock('../src/mailto-handler.js', () => ({
  pickAccount: vi.fn().mockResolvedValue(true),
}));

let groupContainer = '';
vi.mock('../src/native-widgets.js', () => ({
  appGroupContainerPath: vi.fn(() => groupContainer || null),
}));

/** Stages a file the way the Share extension does, and returns its path. */
function stageSharedFile(name: string): string {
  const dir = path.join(groupContainer, 'SharedFiles', '6f1c7a2e-9b3d-4f55-8a01-2d4e6f8a0b1c');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, 'staged attachment');
  return file;
}

function mockAccountsManager(composeWin: unknown = null) {
  return {
    getAccounts: () => [
      { id: 'p', name: 'Personal', partition: 'persist:p', color: '#000', unreadCount: 0 },
    ],
    getActiveAccountId: () => 'p',
    switchAccount: vi.fn(),
    triggerComposePopout: vi.fn().mockResolvedValue(composeWin),
  } as unknown as import('../src/accounts-manager.js').AccountsManager;
}

function mockBrowserWindow() {
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    getSize: vi.fn().mockReturnValue([720, 770]),
    getContentSize: vi.fn().mockReturnValue([720, 742]),
    setSize: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: {
      getURL: vi.fn().mockReturnValue('https://mail.google.com/mail/u/0/?view=cm'),
      isLoading: vi.fn().mockReturnValue(false),
      executeJavaScript: vi.fn().mockResolvedValue(true),
      focus: vi.fn(),
    },
  } as unknown as import('electron').BrowserWindow;
}

describe('handleShareUrl', () => {
  const createdFiles: string[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'share-handler-temp-'));
    groupContainer = fs.mkdtempSync(path.join(os.tmpdir(), 'share-handler-group-'));
  });

  afterEach(() => {
    for (const f of createdFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ok */
      }
    }
    createdFiles.length = 0;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(groupContainer, { recursive: true, force: true });
  });

  it('triggers compose pop-out with shared text and url', async () => {
    const mgr = mockAccountsManager(null);
    await handleShareUrl({
      url: 'magimail://share?text=Check%20this%20out&url=https%3A%2F%2Fexample.com',
      accountsManager: mgr,
    });

    expect(mgr.triggerComposePopout).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Check this out\n\nhttps://example.com',
      }),
    );
  });

  it('injects existing files via native drop and never resizes window', async () => {
    const testFilePath = path.join(os.tmpdir(), `magimail-test-${Date.now()}.pdf`);
    fs.writeFileSync(testFilePath, 'dummy pdf content');
    createdFiles.push(testFilePath);

    const win = mockBrowserWindow();
    const mgr = mockAccountsManager(win);
    const { nativeDropFiles } = await import('../src/native-toolbar.js');

    await handleShareUrl({
      url: `magimail://share?files=${encodeURIComponent(testFilePath)}&text=Here%20is%20the%20file`,
      accountsManager: mgr,
    });

    expect(mgr.triggerComposePopout).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'Here is the file',
      }),
    );
    expect(nativeDropFiles).toHaveBeenCalledWith(
      win,
      expect.arrayContaining([expect.stringContaining(path.basename(testFilePath))]),
    );

    // Crucial check: setSize must NOT be called on attachment drop
    expect(win.setSize).not.toHaveBeenCalled();
  });

  it('removes what the extension staged once the files are attached', async () => {
    const staged = stageSharedFile('invoice.pdf');
    const win = mockBrowserWindow();
    const { nativeDropFiles } = await import('../src/native-toolbar.js');

    await handleShareUrl({
      url: `magimail://share?files=${encodeURIComponent(staged)}`,
      accountsManager: mockAccountsManager(win),
    });

    expect(nativeDropFiles).toHaveBeenCalled();
    expect(fs.existsSync(path.dirname(staged))).toBe(false);
  });

  it('removes what the extension staged even when no compose window opens', async () => {
    const staged = stageSharedFile('invoice.pdf');

    await handleShareUrl({
      url: `magimail://share?files=${encodeURIComponent(staged)}`,
      accountsManager: mockAccountsManager(null),
    });

    expect(fs.existsSync(path.dirname(staged))).toBe(false);
  });

  // The file list arrives from a URL any process can open.
  it('leaves a shared file that the extension did not stage', async () => {
    const outside = path.join(groupContainer, 'not-staging.pdf');
    fs.writeFileSync(outside, 'dummy pdf content');

    await handleShareUrl({
      url: `magimail://share?files=${encodeURIComponent(outside)}`,
      accountsManager: mockAccountsManager(mockBrowserWindow()),
    });

    expect(fs.existsSync(outside)).toBe(true);
  });

  it('skips non-existent files', async () => {
    const fakePath = path.join(os.tmpdir(), 'non-existent-share-file.xyz');

    const win = mockBrowserWindow();
    const mgr = mockAccountsManager(win);
    const { nativeDropFiles } = await import('../src/native-toolbar.js');

    await handleShareUrl({
      url: `magimail://share?files=${encodeURIComponent(fakePath)}`,
      accountsManager: mgr,
    });

    expect(mgr.triggerComposePopout).toHaveBeenCalled();
    expect(nativeDropFiles).not.toHaveBeenCalled();
  });
});
