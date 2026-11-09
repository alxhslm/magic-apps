import { describe, it, expect, vi, beforeEach } from 'vitest';

const openExternalUrl = vi.fn();
vi.mock('@magimail/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@magimail/core')>();
  return {
    ...actual,
    openExternalUrl: (...args: unknown[]) => openExternalUrl(...args),
  };
});

vi.mock('../src/settings-store.js', () => ({
  loadSettings: () => ({
    openLinksIn: 'chrome',
    openLinksInApps: 'auto',
  }),
  saveSetting: vi.fn(),
}));

const accounts = [
  { id: 'a1', partition: 'persist:one', browserProfile: 'Default', email: 'one@example.com' },
];
vi.mock('../src/account-store.js', () => ({ loadAccounts: () => accounts }));

vi.mock('../src/window.js', () => ({
  createComposeWindowOptions: () => ({}),
  createThreadWindowOptions: () => ({}),
}));
vi.mock('../src/css.js', () => ({
  getHideSidebarCss: () => '',
  injectGmailStyles: vi.fn(),
}));

interface Handler {
  (details: { url: string }): { action: string };
}
const handlers: Handler[] = [];
const shellOpenExternal = vi.fn();
const hasApplicationForUrl = vi.fn((_url: string) => true);

vi.mock('../src/native-handlers.js', () => ({
  hasApplicationForUrl: (url: string) => hasApplicationForUrl(url),
}));

vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => shellOpenExternal(url),
  },
  BrowserWindow: class {
    webContents = {
      setWindowOpenHandler: (handler: Handler) => handlers.push(handler),
      once: vi.fn(),
      on: vi.fn(),
    };
    on = vi.fn();
    once = vi.fn();
    show = vi.fn();
    setTitle = vi.fn();
    loadURL = vi.fn();
  },
}));

import { openDetachedComposeWindow } from '../src/compose.js';

describe('links clicked in a pop-out', () => {
  beforeEach(() => {
    handlers.length = 0;
    openExternalUrl.mockClear();
    shellOpenExternal.mockClear();
    hasApplicationForUrl.mockClear();
    hasApplicationForUrl.mockReturnValue(true);
  });

  it('keeps Gmail and sign-in links inside the pop-out', () => {
    openDetachedComposeWindow('/preload.js', 'persist:one');

    for (const url of [
      'https://mail.google.com/mail/u/0/#inbox',
      'https://accounts.google.com/ServiceLogin',
    ]) {
      expect(handlers.at(-1)!({ url })).toEqual({ action: 'allow' });
    }
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(shellOpenExternal).not.toHaveBeenCalled();
  });

  it('routes regular links as the account that owns the pop-out', async () => {
    openDetachedComposeWindow('/preload.js', 'persist:one');

    expect(handlers.at(-1)!({ url: 'https://app.notion.com/p/page' })).toEqual({ action: 'deny' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://app.notion.com/p/page',
      expect.objectContaining({ browser: 'chrome', account: accounts[0] }),
    );
    expect(shellOpenExternal).not.toHaveBeenCalled();
  });

  it('routes Zoom meeting links to the native desktop client when installed', async () => {
    openDetachedComposeWindow('/preload.js', 'persist:one');

    expect(handlers.at(-1)!({ url: 'https://zoom.us/j/1234567890?pwd=secret' })).toEqual({
      action: 'deny',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hasApplicationForUrl).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=1234567890&pwd=secret',
    );
    expect(shellOpenExternal).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=1234567890&pwd=secret',
    );
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('falls back to the browser when the meeting client is not installed', async () => {
    hasApplicationForUrl.mockReturnValue(false);
    openDetachedComposeWindow('/preload.js', 'persist:one');

    expect(handlers.at(-1)!({ url: 'https://zoom.us/j/1234567890?pwd=secret' })).toEqual({
      action: 'deny',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shellOpenExternal).not.toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://zoom.us/j/1234567890?pwd=secret',
      expect.objectContaining({ browser: 'chrome', account: accounts[0] }),
    );
  });
});
