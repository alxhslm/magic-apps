import { describe, it, expect, vi, beforeEach } from 'vitest';

const openExternal = vi.fn();
vi.mock('electron', () => ({
  shell: {
    openExternal: (url: string) => openExternal(url),
  },
}));

const hasApplicationForUrl = vi.fn((_url: string) => true);
vi.mock('../src/native-handlers.js', () => ({
  hasApplicationForUrl: (url: string) => hasApplicationForUrl(url),
}));

const openBrowserUrl = vi.fn();
vi.mock('@magimail/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@magimail/core')>();
  return {
    ...actual,
    openExternalUrl: (...args: unknown[]) => openBrowserUrl(...args),
  };
});

vi.mock('../src/settings-store.js', () => ({
  loadSettings: () => ({
    openLinksIn: 'chrome',
  }),
}));

import { openExternalUrl } from '../src/links.js';

describe('magimail openExternalUrl', () => {
  const account = { id: 'a1', email: 'user@example.com', browserProfile: 'Profile 1' };

  beforeEach(() => {
    openExternal.mockReset();
    openExternal.mockResolvedValue(undefined);
    hasApplicationForUrl.mockReset();
    hasApplicationForUrl.mockReturnValue(true);
    openBrowserUrl.mockReset();
    openBrowserUrl.mockResolvedValue(undefined);
  });

  it('opens Zoom links in native app when installed, keeping pwd', async () => {
    await openExternalUrl('https://zoom.us/j/1234567890?pwd=secretPassword', account);

    expect(hasApplicationForUrl).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=1234567890&pwd=secretPassword',
    );
    expect(openExternal).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=1234567890&pwd=secretPassword',
    );
    expect(openBrowserUrl).not.toHaveBeenCalled();
  });

  it('unwraps redirectors before checking meeting links', async () => {
    const wrapped = `https://www.google.com/url?q=${encodeURIComponent('https://zoom.us/j/99999?pwd=abc')}`;
    await openExternalUrl(wrapped, account);

    expect(hasApplicationForUrl).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=99999&pwd=abc',
    );
    expect(openExternal).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=99999&pwd=abc',
    );
    expect(openBrowserUrl).not.toHaveBeenCalled();
  });

  it('opens Teams links in native app when installed', async () => {
    await openExternalUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz', account);

    expect(hasApplicationForUrl).toHaveBeenCalledWith(
      'msteams://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz',
    );
    expect(openExternal).toHaveBeenCalledWith(
      'msteams://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz',
    );
    expect(openBrowserUrl).not.toHaveBeenCalled();
  });

  it('falls back to browser when client is not installed, without system dialog', async () => {
    hasApplicationForUrl.mockReturnValue(false);

    await openExternalUrl('https://zoom.us/j/1234567890?pwd=abc', account);

    expect(hasApplicationForUrl).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(openBrowserUrl).toHaveBeenCalledWith('https://zoom.us/j/1234567890?pwd=abc', {
      browser: 'chrome',
      account,
    });
  });

  it('falls back to browser when native app throws on open', async () => {
    openExternal.mockRejectedValueOnce(new Error('Launch failed'));

    await openExternalUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz', account);

    expect(openExternal).toHaveBeenCalledWith(
      'msteams://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz',
    );
    expect(openBrowserUrl).toHaveBeenCalledWith(
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz',
      {
        browser: 'chrome',
        account,
      },
    );
  });

  it('opens regular web links directly in browser without asking about native apps', async () => {
    await openExternalUrl('https://github.com/alxhslm/magic-apps', account);

    expect(hasApplicationForUrl).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(openBrowserUrl).toHaveBeenCalledWith('https://github.com/alxhslm/magic-apps', {
      browser: 'chrome',
      account,
    });
  });

  it('accepts options object with browser override', async () => {
    await openExternalUrl('https://github.com/alxhslm/magic-apps', {
      browser: 'safari',
      account,
    });

    expect(openBrowserUrl).toHaveBeenCalledWith('https://github.com/alxhslm/magic-apps', {
      browser: 'safari',
      account,
    });
  });
});
