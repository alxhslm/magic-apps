import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => ({
  app: {
    getApplicationNameForProtocol: vi.fn(() => 'Firefox'),
  },
  shell: {
    openExternal: vi.fn(),
  },
}));

import {
  getChromiumProfiles,
  resolveChromiumProfile,
  openExternalUrl,
  getDefaultBrowser,
  SUPPORTED_BROWSERS,
} from '../src/browser-router.js';

describe('browser-router', () => {
  const tmpDir = path.join(os.tmpdir(), `test-browser-router-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it('SUPPORTED_BROWSERS includes system, chrome, brave, edge, safari', () => {
    const ids = SUPPORTED_BROWSERS.map((b) => b.id);
    expect(ids).toContain('system');
    expect(ids).toContain('chrome');
    expect(ids).toContain('brave');
    expect(ids).toContain('edge');
    expect(ids).toContain('safari');
  });

  it('getChromiumProfiles returns empty array when file does not exist', () => {
    const profiles = getChromiumProfiles('chrome', tmpDir);
    expect(profiles).toEqual([]);
  });

  it('getChromiumProfiles parses Local State correctly', () => {
    const chromeDir = path.join(tmpDir, 'Library/Application Support/Google/Chrome');
    fs.mkdirSync(chromeDir, { recursive: true });

    const localState = {
      profile: {
        info_cache: {
          'Profile 1': {
            name: 'Work',
            user_name: 'work@company.com',
            gaia_name: 'Alex Work',
          },
          Default: {
            name: 'Personal',
            user_name: 'personal@gmail.com',
            gaia_name: 'Alex Personal',
          },
        },
      },
    };

    fs.writeFileSync(path.join(chromeDir, 'Local State'), JSON.stringify(localState));

    const profiles = getChromiumProfiles('chrome', tmpDir);
    expect(profiles).toHaveLength(2);
    // Default should be sorted first
    expect(profiles[0]?.directory).toBe('Default');
    expect(profiles[0]?.name).toBe('Personal');
    expect(profiles[0]?.email).toBe('personal@gmail.com');

    expect(profiles[1]?.directory).toBe('Profile 1');
    expect(profiles[1]?.name).toBe('Work');
    expect(profiles[1]?.email).toBe('work@company.com');
  });

  it('resolveChromiumProfile matches explicit profile directory if present', () => {
    const chromeDir = path.join(tmpDir, 'Library/Application Support/Google/Chrome');
    fs.mkdirSync(chromeDir, { recursive: true });

    fs.writeFileSync(
      path.join(chromeDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            'Profile 1': { name: 'Work', user_name: 'work@company.com' },
            Default: { name: 'Personal', user_name: 'personal@gmail.com' },
          },
        },
      }),
    );

    const resolved = resolveChromiumProfile('chrome', 'Profile 1', 'other@test.com', tmpDir);
    expect(resolved).toBe('Profile 1');

    const nonExistent = resolveChromiumProfile('chrome', 'Profile 99', 'other@test.com', tmpDir);
    expect(nonExistent).toBeNull();
  });

  it('resolveChromiumProfile auto-matches profile by account email', () => {
    const chromeDir = path.join(tmpDir, 'Library/Application Support/Google/Chrome');
    fs.mkdirSync(chromeDir, { recursive: true });

    fs.writeFileSync(
      path.join(chromeDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            'Profile 1': { name: 'Work', user_name: 'Work@Company.com' },
            Default: { name: 'Personal', user_name: 'personal@gmail.com' },
          },
        },
      }),
    );

    const matchWork = resolveChromiumProfile('chrome', '_auto', 'work@company.com', tmpDir);
    expect(matchWork).toBe('Profile 1');

    const matchPersonal = resolveChromiumProfile('chrome', undefined, 'PERSONAL@gmail.com', tmpDir);
    expect(matchPersonal).toBe('Default');

    // Nothing matches, so no profile is named and Chromium keeps the one it is in.
    const unknown = resolveChromiumProfile('chrome', '_auto', 'random@xyz.com', tmpDir);
    expect(unknown).toBeNull();
  });

  it('resolveChromiumProfile names no profile when the email matches none', () => {
    const chromeDir = path.join(tmpDir, 'Library/Application Support/Google/Chrome');
    fs.mkdirSync(chromeDir, { recursive: true });

    fs.writeFileSync(
      path.join(chromeDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: 'Personal', user_name: 'personal@gmail.com' },
            'Profile 1': { name: 'Work', user_name: 'work@company.com' },
          },
          last_used: 'Profile 1',
        },
      }),
    );

    // No profile carries the account's address, so the launch line stays free of
    // `--profile-directory` and Chromium opens the link where it already is.
    expect(resolveChromiumProfile('chrome', '_auto', 'random@xyz.com', tmpDir)).toBeNull();
    // A profile that does carry it wins, which is what the email match is for.
    expect(resolveChromiumProfile('chrome', '_auto', 'personal@gmail.com', tmpDir)).toBe('Default');
  });

  it('openExternalUrl hands the URL to the open window when the profile is the current one', async () => {
    const chromeDir = path.join(tmpDir, 'Library/Application Support/Google/Chrome');
    fs.mkdirSync(chromeDir, { recursive: true });

    fs.writeFileSync(
      path.join(chromeDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: { Default: { name: 'Personal', user_name: 'personal@gmail.com' } },
          last_used: 'Default',
        },
      }),
    );

    const fallback = vi.fn().mockResolvedValue(undefined);
    const runner = vi.fn().mockResolvedValue(undefined);

    await openExternalUrl('https://example.com', {
      browser: 'chrome',
      account: { browserProfile: '_auto', email: 'personal@gmail.com' },
      customHome: tmpDir,
      fallbackOpenExternal: fallback,
      openCommandRunner: runner,
    });

    // `-n` would start a second browser for a profile that is already on screen.
    expect(runner).toHaveBeenCalledWith(['-b', 'com.google.Chrome', 'https://example.com']);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('openExternalUrl delegates non-http URLs to fallback', async () => {
    const fallback = vi.fn().mockResolvedValue(undefined);
    const runner = vi.fn().mockResolvedValue(undefined);

    await openExternalUrl('mailto:test@example.com', {
      browser: 'chrome',
      fallbackOpenExternal: fallback,
      openCommandRunner: runner,
    });

    expect(fallback).toHaveBeenCalledWith('mailto:test@example.com');
    expect(runner).not.toHaveBeenCalled();
  });

  it('openExternalUrl delegates system browser to fallback', async () => {
    const fallback = vi.fn().mockResolvedValue(undefined);
    const runner = vi.fn().mockResolvedValue(undefined);

    await openExternalUrl('https://example.com', {
      account: { browser: 'system' },
      fallbackOpenExternal: fallback,
      openCommandRunner: runner,
    });

    expect(fallback).toHaveBeenCalledWith('https://example.com');
    expect(runner).not.toHaveBeenCalled();
  });

  it('openExternalUrl launches Safari with bundle ID', async () => {
    const fallback = vi.fn().mockResolvedValue(undefined);
    const runner = vi.fn().mockResolvedValue(undefined);

    await openExternalUrl('https://example.com', {
      browser: 'safari',
      fallbackOpenExternal: fallback,
      openCommandRunner: runner,
    });

    expect(runner).toHaveBeenCalledWith(['-b', 'com.apple.Safari', 'https://example.com']);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('openExternalUrl launches Chromium with profile flag when profile is found', async () => {
    const chromeDir = path.join(tmpDir, 'Library/Application Support/Google/Chrome');
    fs.mkdirSync(chromeDir, { recursive: true });
    fs.writeFileSync(
      path.join(chromeDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            'Profile 2': { name: 'Work', user_name: 'alex@corp.com' },
          },
        },
      }),
    );

    const fallback = vi.fn().mockResolvedValue(undefined);
    const runner = vi.fn().mockResolvedValue(undefined);

    await openExternalUrl('https://meet.google.com/abc', {
      browser: 'chrome',
      account: {
        browserProfile: '_auto',
        email: 'alex@corp.com',
      },
      customHome: tmpDir,
      fallbackOpenExternal: fallback,
      openCommandRunner: runner,
    });

    expect(runner).toHaveBeenCalledWith([
      '-b',
      'com.google.Chrome',
      '-n',
      '--args',
      '--profile-directory=Profile 2',
      'https://meet.google.com/abc',
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('openExternalUrl launches Brave and Edge identically', async () => {
    const braveDir = path.join(tmpDir, 'Library/Application Support/BraveSoftware/Brave-Browser');
    fs.mkdirSync(braveDir, { recursive: true });
    fs.writeFileSync(
      path.join(braveDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            Default: { name: 'Person 1', user_name: 'brave@test.com' },
          },
        },
      }),
    );

    const fallback = vi.fn().mockResolvedValue(undefined);
    const runner = vi.fn().mockResolvedValue(undefined);

    await openExternalUrl('https://example.com', {
      browser: 'brave',
      account: { browserProfile: 'Default' },
      customHome: tmpDir,
      fallbackOpenExternal: fallback,
      openCommandRunner: runner,
    });

    expect(runner).toHaveBeenCalledWith([
      '-b',
      'com.brave.Browser',
      '-n',
      '--args',
      '--profile-directory=Default',
      'https://example.com',
    ]);
  });

  it('openExternalUrl falls back to system openExternal when runner fails', async () => {
    const fallback = vi.fn().mockResolvedValue(undefined);
    const runner = vi.fn().mockRejectedValue(new Error('App not found'));

    await openExternalUrl('https://example.com', {
      browser: 'chrome',
      customHome: tmpDir,
      fallbackOpenExternal: fallback,
      openCommandRunner: runner,
    });

    expect(fallback).toHaveBeenCalledWith('https://example.com');
  });
});

describe('getDefaultBrowser', () => {
  const plistWith = (...handlers: Record<string, unknown>[]): string =>
    JSON.stringify({ LSHandlers: handlers });

  it('maps a Chromium browser by its https handler bundle identifier', () => {
    const browser = getDefaultBrowser({
      readPlistJson: () =>
        plistWith(
          { LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' },
          { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.Chrome' },
        ),
    });

    expect(browser).toMatchObject({ id: 'chrome', name: 'Google Chrome', isChromium: true });
  });

  it('reads LSHandlerRoleViewer, which is what the system settings row writes', () => {
    const browser = getDefaultBrowser({
      readPlistJson: () =>
        plistWith({ LSHandlerURLScheme: 'https', LSHandlerRoleViewer: 'com.brave.Browser' }),
    });

    expect(browser).toMatchObject({ id: 'brave', isChromium: true });
  });

  it('prefers the role-all entry when both are recorded', () => {
    const browser = getDefaultBrowser({
      readPlistJson: () =>
        plistWith({
          LSHandlerURLScheme: 'https',
          LSHandlerRoleAll: 'com.microsoft.edgemac',
          LSHandlerRoleViewer: 'com.apple.Safari',
        }),
    });

    expect(browser.id).toBe('edge');
  });

  it('falls back to Safari when no https handler is recorded', () => {
    const browser = getDefaultBrowser({
      readPlistJson: () =>
        plistWith({ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' }),
    });

    expect(browser).toMatchObject({ id: 'safari', isChromium: false });
  });

  it('reports a browser outside the list as other, with no profile support', () => {
    const browser = getDefaultBrowser({
      readPlistJson: () =>
        plistWith({ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'org.mozilla.firefox' }),
    });

    expect(browser).toMatchObject({
      id: 'other',
      bundleId: 'org.mozilla.firefox',
      isChromium: false,
    });
  });

  it('falls back to Safari when the plist cannot be read', () => {
    const browser = getDefaultBrowser({
      readPlistJson: () => {
        throw new Error('plutil: file not found');
      },
    });

    expect(browser.id).toBe('safari');
  });

  it('falls back to Safari on a plist with no LSHandlers array', () => {
    const browser = getDefaultBrowser({
      readPlistJson: () => JSON.stringify({}),
    });

    expect(browser.id).toBe('safari');
  });
});
