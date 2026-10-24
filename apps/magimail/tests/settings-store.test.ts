import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  configureSecretFiles,
  readSecretFile,
  resetSecretFiles,
  writeSecretFile,
} from '@magimail/core';

/**
 * Run against real files in a temporary userData directory. The thing under
 * test is what lands on disk and what comes back from it, which a mocked `fs`
 * would replace with this file's own assumptions.
 */

let userData: string;
let settingsPath: string;

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userData),
  },
}));

const KEY = Buffer.alloc(32, 1);
const OTHER_KEY = Buffer.alloc(32, 2);

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/**
 * Reads and writes the file as a packaged build does, under `key`.
 *
 * This is the test's own view of the disk, which is deliberately not the
 * store's: a test seeds a file under one key and then launches the store under
 * another to see what an unreadable file does to it.
 */
function packagedDisk(key: Buffer): void {
  configureSecretFiles({ isPackaged: true, fetchKey: () => key, logger: silentLogger() });
}

/** Puts a settings file on disk, as the previous session would have left it. */
function seedSettings(data: Record<string, unknown>): void {
  writeSecretFile(settingsPath, data);
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'magimail-settings-'));
  settingsPath = path.join(userData, 'settings.json');
  resetSecretFiles();
});

afterEach(() => {
  resetSecretFiles();
  fs.rmSync(userData, { recursive: true, force: true });
});

/**
 * Starts the store as a launch would, on a build holding `key`.
 *
 * The module remembers the settings it loaded, and its refusal to overwrite a
 * file it could not read, for the life of the process; each launch therefore
 * starts from a fresh module registry, and the build is named inside that same
 * registry so the store and its files agree on the key.
 */
async function launch(key?: Buffer) {
  vi.resetModules();
  if (key) {
    const core = await import('@magimail/core');
    core.configureSecretFiles({ isPackaged: true, fetchKey: () => key, logger: silentLogger() });
  }
  return await import('../src/settings-store.js');
}

describe('settings-store', () => {
  describe('loadSettings', () => {
    it('returns default settings when no settings file exists', async () => {
      const { loadSettings } = await launch();
      const settings = loadSettings();
      expect(settings.theme).toBe('system');
      expect(settings.notifications.primary).toBe('loud');
      expect(settings.notifications.forums).toBe('off');
      expect(settings.dockBadgeMode).toBe('allUnread');
    });

    it('merges persisted settings over defaults', async () => {
      seedSettings({
        theme: 'dark',
        notifications: {
          primary: 'silent',
          updates: 'off',
          promotions: 'badge',
          social: 'badge',
          forums: 'off',
        },
      });
      const { loadSettings } = await launch();
      const settings = loadSettings();
      expect(settings.theme).toBe('dark');
      expect(settings.notifications.primary).toBe('silent');
      // Keys absent from the file retain their defaults
      expect(settings.dockBadgeMode).toBe('allUnread');
    });

    it('reads a file left as plaintext by an older build', async () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ theme: 'light' }), 'utf8');
      const { loadSettings } = await launch();
      expect(loadSettings().theme).toBe('light');
    });

    it('carries a pre-mode showDockBadge:false across to dockBadgeMode', async () => {
      seedSettings({ showDockBadge: false });
      const { loadSettings } = await launch();
      const settings = loadSettings();
      expect(settings.dockBadgeMode).toBe('off');
      expect(settings).not.toHaveProperty('showDockBadge');
    });

    it('leaves the default alone when the pre-mode badge was on', async () => {
      seedSettings({ showDockBadge: true });
      const { loadSettings } = await launch();
      expect(loadSettings().dockBadgeMode).toBe('allUnread');
    });

    it('an explicit mode wins over a stale showDockBadge', async () => {
      seedSettings({ showDockBadge: false, dockBadgeMode: 'newArrivals' });
      const { loadSettings } = await launch();
      expect(loadSettings().dockBadgeMode).toBe('newArrivals');
    });
  });

  describe('saveSetting — flat keys', () => {
    it('persists a flat boolean key', async () => {
      const { loadSettings, saveSetting } = await launch();
      saveSetting('menuBarShowDots', false);
      expect(loadSettings().menuBarShowDots).toBe(false);
      expect(readSecretFile<Record<string, unknown>>(settingsPath)?.menuBarShowDots).toBe(false);
    });

    it('persists a flat string key', async () => {
      const { loadSettings, saveSetting } = await launch();
      saveSetting('theme', 'dark');
      expect(loadSettings().theme).toBe('dark');
    });

    it('persists a flat number key', async () => {
      const { loadSettings, saveSetting } = await launch();
      saveSetting('pollIntervalSeconds', 300);
      expect(loadSettings().pollIntervalSeconds).toBe(300);
    });
  });

  describe('saveSetting — nested dot-notation keys', () => {
    it('saves notifications.primary into the nested object, not as a root key', async () => {
      const { loadSettings, saveSetting } = await launch();
      saveSetting('notifications.primary', 'silent');
      const settings = loadSettings();
      expect(settings.notifications.primary).toBe('silent');
      // Must NOT create a spurious root-level key
      expect(
        (settings as unknown as Record<string, unknown>)['notifications.primary'],
      ).toBeUndefined();
    });

    it('saves notifications.forums without touching other notification keys', async () => {
      const { loadSettings, saveSetting } = await launch();
      // Default for forums is 'off'; change it to 'loud'
      saveSetting('notifications.forums', 'loud');
      const settings = loadSettings();
      expect(settings.notifications.forums).toBe('loud');
      // Other notification settings remain at their defaults
      expect(settings.notifications.primary).toBe('loud');
      expect(settings.notifications.updates).toBe('silent');
      expect(settings.notifications.promotions).toBe('badge');
      expect(settings.notifications.social).toBe('badge');
    });

    it('saves notifications.promotions correctly', async () => {
      const { loadSettings, saveSetting } = await launch();
      saveSetting('notifications.promotions', 'off');
      const settings = loadSettings();
      expect(settings.notifications.promotions).toBe('off');
      expect(
        (settings as unknown as Record<string, unknown>)['notifications.promotions'],
      ).toBeUndefined();
    });

    it('writes the nested value as a nested structure', async () => {
      const { saveSetting } = await launch();
      saveSetting('notifications.social', 'off');
      const written = readSecretFile<Record<string, Record<string, unknown>>>(settingsPath) ?? {};
      expect(written.notifications?.social).toBe('off');
      expect(Object.keys(written)).not.toContain('notifications.social');
    });
  });

  describe('an unrecognised key', () => {
    it('is refused rather than written', async () => {
      const { saveSetting } = await launch();

      // The Swift settings window sends keys by name, so a misspelling arrives
      // as a plausible string and used to land in the file as dead weight.
      saveSetting('lauchAtLogin', true);

      expect(readSecretFile<Record<string, unknown>>(settingsPath)?.lauchAtLogin).toBeUndefined();
    });

    it('leaves the settings it was given untouched', async () => {
      const { loadSettings, saveSetting } = await launch();
      saveSetting('hideSidebar', true);

      const after = saveSetting('notAThing', 'x');

      expect(after.hideSidebar).toBe(true);
      expect(loadSettings().hideSidebar).toBe(true);
    });
  });

  describe('on a packaged build', () => {
    beforeEach(() => {
      packagedDisk(KEY);
    });

    it('keeps no setting in the clear on disk', async () => {
      const { saveSetting } = await launch(KEY);
      saveSetting('quickComposeHotkey', 'Shift+Command+C');
      const bytes = fs.readFileSync(settingsPath);
      expect(bytes.includes('quickComposeHotkey')).toBe(false);
      expect(readSecretFile<Record<string, unknown>>(settingsPath)?.quickComposeHotkey).toBe(
        'Shift+Command+C',
      );
    });

    it('encrypts a file an older build left in the clear, on the next write', async () => {
      fs.writeFileSync(settingsPath, JSON.stringify({ hideSidebar: true }), 'utf8');
      const { saveSetting } = await launch(KEY);
      saveSetting('theme', 'dark');
      const bytes = fs.readFileSync(settingsPath);
      expect(bytes.subarray(0, 6).toString('ascii')).toBe('MAGBOX');
      expect(readSecretFile<Record<string, unknown>>(settingsPath)?.hideSidebar).toBe(true);
    });
  });

  describe('a settings file that will not decrypt', () => {
    let onDisk: Buffer;

    beforeEach(() => {
      packagedDisk(OTHER_KEY);
      seedSettings({ theme: 'dark', hideSidebar: true, pollIntervalSeconds: 300 });
      onDisk = fs.readFileSync(settingsPath);
    });

    it('runs the session on defaults', async () => {
      const { loadSettings } = await launch(KEY);
      const settings = loadSettings();
      expect(settings.theme).toBe('system');
      expect(settings.hideSidebar).toBe(false);
      expect(settings.pollIntervalSeconds).toBe(60);
    });

    it('is left exactly as it was found, however many settings are changed', async () => {
      const { saveSetting } = await launch(KEY);
      saveSetting('theme', 'light');
      saveSetting('notifications.primary', 'off');
      expect(fs.readFileSync(settingsPath)).toEqual(onDisk);
    });

    it('still applies a changed setting for the rest of the session', async () => {
      const { loadSettings, saveSetting } = await launch(KEY);
      saveSetting('theme', 'light');
      expect(loadSettings().theme).toBe('light');
    });

    it('leaves no temporary file behind', async () => {
      const { saveSetting } = await launch(KEY);
      saveSetting('theme', 'light');
      expect(fs.existsSync(`${settingsPath}.tmp`)).toBe(false);
    });

    it('reads it again on the next launch, once the key is back', async () => {
      const { loadSettings } = await launch(KEY);
      loadSettings();

      const relaunched = await launch(OTHER_KEY);
      expect(relaunched.loadSettings().theme).toBe('dark');
    });
  });
});
