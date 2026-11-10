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

let mockAlwaysJoinInBrowser = false;
vi.mock('../src/settings-store.js', () => ({
  loadSettings: () => ({
    openLinksIn: 'system',
    alwaysJoinInBrowser: mockAlwaysJoinInBrowser,
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
    mockAlwaysJoinInBrowser = false;
  });

  it('keeps Zoom and Teams links in browser when alwaysJoinInBrowser is enabled', async () => {
    mockAlwaysJoinInBrowser = true;
    await openExternalUrl('https://zoom.us/j/1234567890?pwd=secretPassword', account);

    expect(openExternal).toHaveBeenCalledWith('https://zoom.us/j/1234567890?pwd=secretPassword');
  });

  it('opens Zoom links in native app when installed, keeping pwd', async () => {
    await openExternalUrl('https://zoom.us/j/1234567890?pwd=secretPassword', account);

    expect(hasApplicationForUrl).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=1234567890&pwd=secretPassword',
    );
    expect(openExternal).toHaveBeenCalledWith(
      'zoommtg://zoom.us/join?action=join&confno=1234567890&pwd=secretPassword',
    );
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
  });

  it('opens Teams links in native app when installed', async () => {
    await openExternalUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz', account);

    expect(hasApplicationForUrl).toHaveBeenCalledWith(
      'msteams://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz',
    );
    expect(openExternal).toHaveBeenCalledWith(
      'msteams://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz',
    );
  });

  it('falls back to browser when client is not installed, without system dialog', async () => {
    hasApplicationForUrl.mockReturnValue(false);

    await openExternalUrl('https://zoom.us/j/1234567890?pwd=abc', account);

    expect(hasApplicationForUrl).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://zoom.us/j/1234567890?pwd=abc');
  });

  it('falls back to browser when native app throws on open', async () => {
    openExternal.mockRejectedValueOnce(new Error('Launch failed'));

    await openExternalUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz', account);

    expect(openExternal).toHaveBeenNthCalledWith(
      1,
      'msteams://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz',
    );
    expect(openExternal).toHaveBeenNthCalledWith(
      2,
      'https://teams.microsoft.com/l/meetup-join/19%3ameeting_xyz',
    );
  });

  it('opens regular web links directly in browser without asking about native apps', async () => {
    await openExternalUrl('https://github.com/alxhslm/magic-apps', account);

    expect(hasApplicationForUrl).not.toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://github.com/alxhslm/magic-apps');
  });
});
