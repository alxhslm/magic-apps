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
vi.mock('electron', () => ({
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
  });

  it('routes everything else as the account that owns the pop-out', () => {
    openDetachedComposeWindow('/preload.js', 'persist:one');

    expect(handlers.at(-1)!({ url: 'https://app.notion.com/p/page' })).toEqual({ action: 'deny' });
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://app.notion.com/p/page',
      expect.objectContaining({ browser: 'chrome', account: accounts[0] }),
    );
  });
});
