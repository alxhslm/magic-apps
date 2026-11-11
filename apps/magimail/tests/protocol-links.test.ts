import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    name: 'Magimail',
    getPath: vi.fn().mockReturnValue('/tmp'),
    setPath: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    getVersion: vi.fn().mockReturnValue('1.0.0'),
    isPackaged: false,
    on: vi.fn(),
    whenReady: vi.fn().mockReturnValue(new Promise(() => {})),
    requestSingleInstanceLock: vi.fn().mockReturnValue(true),
  },
  BaseWindow: vi.fn(),
  BrowserWindow: vi.fn(),
  dialog: { showMessageBox: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  net: {},
  powerMonitor: { on: vi.fn() },
  session: {},
  shell: {},
}));

import { accountIdFromLink, isAllowedGmailNavigationUrl } from '../src/protocol-links.js';
import { dispatchProtocolUrl, MAILBOX_ROUTES } from '../src/main.js';

describe('accountIdFromLink', () => {
  it('reads the account a thread, inbox, search or compose link names', () => {
    expect(accountIdFromLink('magimail://thread/EID?account=work&action=open')).toBe('work');
    expect(accountIdFromLink('magimail://inbox?account=work')).toBe('work');
    expect(accountIdFromLink('magimail://search?q=invoice&account=work')).toBe('work');
    expect(accountIdFromLink('magimail://compose?account=work')).toBe('work');
    expect(
      accountIdFromLink(
        'magimail://navigate?url=https%3A%2F%2Fmail.google.com%2Fmail&account=work',
      ),
    ).toBe('work');
  });

  it('leaves the choice alone for a mailto: or a link with no account', () => {
    expect(accountIdFromLink('mailto:someone@example.com')).toBeUndefined();
    expect(accountIdFromLink('magimail://inbox')).toBeUndefined();
  });

  it('is undefined for anything that is not a magimail link', () => {
    expect(accountIdFromLink('https://mail.google.com/?account=work')).toBeUndefined();
    expect(accountIdFromLink('not a url')).toBeUndefined();
    expect(accountIdFromLink('')).toBeUndefined();
  });
});

describe('isAllowedGmailNavigationUrl', () => {
  it('allows mail.google.com and gmail.com hosts', () => {
    expect(isAllowedGmailNavigationUrl('https://mail.google.com/mail/u/0/#settings/labels')).toBe(
      true,
    );
    expect(isAllowedGmailNavigationUrl('https://gmail.com/mail/u/0/#inbox')).toBe(true);
    expect(isAllowedGmailNavigationUrl('https://www.gmail.com/mail/u/0/#sent')).toBe(true);
    expect(
      isAllowedGmailNavigationUrl(
        'https://mail.google.com/mail?extsrc=cal&plid=ACUX6DNwTK67PHrtKuZt6DrTTz3oL-Ztw6XYr8A',
      ),
    ).toBe(true);
  });

  it('rejects external and non-Gmail URLs, and plaintext http', () => {
    expect(isAllowedGmailNavigationUrl('http://mail.google.com/mail/u/0/#inbox')).toBe(false);
    expect(isAllowedGmailNavigationUrl('https://calendar.google.com/calendar/r')).toBe(false);
    expect(isAllowedGmailNavigationUrl('https://google.com/search?q=gmail')).toBe(false);
    expect(isAllowedGmailNavigationUrl('https://evil.com/mail.google.com')).toBe(false);
    expect(isAllowedGmailNavigationUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedGmailNavigationUrl('not a url')).toBe(false);
  });
});

describe('dispatchProtocolUrl', () => {
  it('routes incoming magimail://snoozed to https://mail.google.com/mail/u/0/#snoozed in accountsManager.openInAccount', async () => {
    const mockAccountsManager = {
      openInAccount: vi.fn(),
    };

    await dispatchProtocolUrl('magimail://snoozed', mockAccountsManager);

    expect(mockAccountsManager.openInAccount).toHaveBeenCalledWith(
      undefined,
      'https://mail.google.com/mail/u/0/#snoozed',
    );
  });

  it('preserves account parameter when routing snoozed mailbox', async () => {
    const mockAccountsManager = {
      openInAccount: vi.fn(),
    };

    await dispatchProtocolUrl('magimail://snoozed?account=work', mockAccountsManager);

    expect(mockAccountsManager.openInAccount).toHaveBeenCalledWith(
      'work',
      'https://mail.google.com/mail/u/0/#snoozed',
    );
  });

  it('includes snoozed in MAILBOX_ROUTES', () => {
    expect(MAILBOX_ROUTES.snoozed).toBe('#snoozed');
  });
});
