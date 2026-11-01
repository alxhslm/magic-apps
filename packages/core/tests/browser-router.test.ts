import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn(),
  },
}));

import {
  getChromiumProfiles,
  resolveChromiumProfile,
  openExternalUrl,
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

    // Unknown email falls back to Default
    const unknown = resolveChromiumProfile('chrome', '_auto', 'random@xyz.com', tmpDir);
    expect(unknown).toBe('Default');
  });

  it('openExternalUrl delegates non-http URLs to fallback', async () => {
    const fallback = vi.fn().mockResolvedValue(undefined);
    const runner = vi.fn().mockResolvedValue(undefined);

    await openExternalUrl('mailto:test@example.com', {
      account: { browser: 'chrome' },
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
      account: { browser: 'safari' },
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
      account: {
        browser: 'chrome',
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
      account: {
        browser: 'brave',
        browserProfile: 'Default',
      },
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
      account: { browser: 'chrome' },
      customHome: tmpDir,
      fallbackOpenExternal: fallback,
      openCommandRunner: runner,
    });

    expect(fallback).toHaveBeenCalledWith('https://example.com');
  });
});
