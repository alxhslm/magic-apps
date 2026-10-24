import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configureSecretFiles, resetSecretFiles, writeSecretFile } from '@magimail/core';
import { DefaultClientManager } from '../src/default-client.js';
import { app, dialog } from 'electron';

let userData: string;
let preferencePath: string;

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userData),
    isDefaultProtocolClient: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn(),
  },
  BrowserWindow: vi.fn(),
}));

const KEY = Buffer.alloc(32, 5);
const OTHER_KEY = Buffer.alloc(32, 6);

function packagedBuild(key: Buffer): void {
  configureSecretFiles({
    isPackaged: true,
    fetchKey: () => key,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

/** A window that is open, which is all `checkOnStartup` asks of one. */
function openWindow() {
  return { isDestroyed: () => false } as unknown as import('electron').BrowserWindow;
}

describe('DefaultClientManager', () => {
  beforeEach(() => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'magimail-default-client-'));
    preferencePath = path.join(userData, 'default-client-preference.json');
    resetSecretFiles();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetSecretFiles();
    fs.rmSync(userData, { recursive: true, force: true });
  });

  it('checks if app is default protocol client', () => {
    vi.mocked(app.isDefaultProtocolClient).mockReturnValue(true);
    const manager = new DefaultClientManager();
    expect(manager.isDefault()).toBe(true);
    expect(app.isDefaultProtocolClient).toHaveBeenCalledWith('mailto');
  });

  it('sets app as default protocol client', () => {
    vi.mocked(app.setAsDefaultProtocolClient).mockReturnValue(true);
    const manager = new DefaultClientManager();
    expect(manager.setAsDefault()).toBe(true);
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('mailto');
  });

  it('prompts user on startup if not default', async () => {
    vi.mocked(app.isDefaultProtocolClient).mockReturnValue(false);
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 0, // Set as Default
      checkboxChecked: false,
    });

    const mockWin = openWindow();
    const manager = new DefaultClientManager();
    await manager.checkOnStartup(mockWin);

    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      mockWin,
      expect.objectContaining({
        message: 'Set Magimail as your default email reader?',
      }),
    );
    expect(app.setAsDefaultProtocolClient).toHaveBeenCalledWith('mailto');
  });

  it('stays quiet once the user has asked it to', async () => {
    vi.mocked(app.isDefaultProtocolClient).mockReturnValue(false);
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 2, // Don't Ask Again
      checkboxChecked: false,
    });

    await new DefaultClientManager().checkOnStartup(openWindow());
    await new DefaultClientManager().checkOnStartup(openWindow());

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('asks again when the preference will not decrypt', async () => {
    packagedBuild(OTHER_KEY);
    writeSecretFile(preferencePath, { dontAskAgain: true });
    resetSecretFiles();
    packagedBuild(KEY);

    vi.mocked(app.isDefaultProtocolClient).mockReturnValue(false);
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 1, // Not Now
      checkboxChecked: false,
    });

    await new DefaultClientManager().checkOnStartup(openWindow());

    expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});
