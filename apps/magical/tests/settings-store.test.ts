import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The module imports `app` to locate userData. Mocked so the suite never resolves the
// real Electron binary, and so each test can point the store at its own directory.
const userData = vi.hoisted(() => ({ dir: '/tmp/magical-test-settings' }));
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userData.dir) },
}));

const { mergeSettings } = await import('../src/settings-store.js');

describe('mergeSettings', () => {
  it('falls back to defaults for a missing or unreadable file', () => {
    expect(mergeSettings(null).theme).toBe('system');
    expect(mergeSettings('not an object').transparentBackground).toBe(true);
  });

  it('keeps stored values', () => {
    const merged = mergeSettings({ theme: 'dark', hideSidebar: true });
    expect(merged.theme).toBe('dark');
    expect(merged.hideSidebar).toBe(true);
    expect(merged.transparentBackground).toBe(true);
  });

  it('drops keys that are no longer settings', () => {
    // A setting retired in a later build must not linger in the file and
    // quietly reappear when it is next reinstated under the same name.
    // `hideAccountChrome` is one that actually was retired.
    const merged = mergeSettings({ theme: 'light', hideAccountChrome: true });
    expect('hideAccountChrome' in merged).toBe(false);
  });

  it('ignores a stored value of the wrong type', () => {
    expect(mergeSettings({ transparentBackground: 'yes' }).transparentBackground).toBe(true);
  });

  it('leaves the sidebar alone by default, matching Magimail', () => {
    expect(mergeSettings({}).hideSidebar).toBe(false);
  });

  it('defaults inactiveAccountSuspendMinutes to 5', () => {
    expect(mergeSettings({}).inactiveAccountSuspendMinutes).toBe(5);
  });

  it('counts every outstanding invitation on the badge by default', () => {
    expect(mergeSettings({}).dockBadgeMode).toBe('allPending');
  });

  it('preserves a stored dockBadgeMode', () => {
    expect(mergeSettings({ dockBadgeMode: 'newInvitations' }).dockBadgeMode).toBe('newInvitations');
  });

  it('preserves inactiveAccountSuspendMinutes from stored settings', () => {
    expect(mergeSettings({ inactiveAccountSuspendMinutes: 30 }).inactiveAccountSuspendMinutes).toBe(
      30,
    );
    expect(mergeSettings({ inactiveAccountSuspendMinutes: 0 }).inactiveAccountSuspendMinutes).toBe(
      0,
    );
  });

  it('defaults showCompletedTasks to true', () => {
    expect(mergeSettings({}).showCompletedTasks).toBe(true);
    expect(mergeSettings({ showCompletedTasks: false }).showCompletedTasks).toBe(false);
  });

  it('leaves the Tasks switcher alone by default and honours a stored choice', () => {
    expect(mergeSettings({}).hideTasksTab).toBe(false);
    expect(mergeSettings({ hideTasksTab: true }).hideTasksTab).toBe(true);
    // A stored value of the wrong type is ignored.
    expect(mergeSettings({ hideTasksTab: 'yes' }).hideTasksTab).toBe(false);
  });

  it('defaults openTodoistInDesktopApp to true and honours a stored choice', () => {
    expect(mergeSettings({}).openTodoistInDesktopApp).toBe(true);
    expect(mergeSettings({ openTodoistInDesktopApp: false }).openTodoistInDesktopApp).toBe(false);
    expect(mergeSettings({ openTodoistInDesktopApp: 'no' }).openTodoistInDesktopApp).toBe(true);
  });
});

describe('array settings', () => {
  it('keeps a stored list of hidden calendars', () => {
    const hidden = [
      { accountId: 'acc_1', calendarId: 'cal_a' },
      { accountId: 'acc_1', calendarId: 'cal_b' },
    ];
    expect(mergeSettings({ hiddenCalendars: hidden }).hiddenCalendars).toEqual(hidden);
  });

  it('keeps a stored list of disabled alert calendars', () => {
    expect(
      mergeSettings({ disabledAlertCalendarIds: ['cal_work', 'cal_team'] })
        .disabledAlertCalendarIds,
    ).toEqual(['cal_work', 'cal_team']);
  });

  it('defaults disabledAlertCalendarIds to an empty list', () => {
    expect(mergeSettings({}).disabledAlertCalendarIds).toEqual([]);
  });

  it('falls back to the default when the stored value is not a list of ids', () => {
    // `typeof null` and `typeof {}` are both 'object', so a type check alone would let
    // either through where a list belongs.
    for (const bad of [null, {}, 'cal_a', [1, 2], ['cal_a', 3]]) {
      expect(mergeSettings({ hiddenCalendars: bad }).hiddenCalendars).toEqual([]);
      expect(mergeSettings({ disabledAlertCalendarIds: bad }).disabledAlertCalendarIds).toEqual([]);
    }
  });
});

describe('settings.json on disk', () => {
  const KEY = Buffer.alloc(32, 7);

  const settingsFile = () => path.join(userData.dir, 'settings.json');

  function silentLogger() {
    return { info: () => {}, warn: () => {}, error: () => {} };
  }

  /**
   * A relaunch: the settings held in memory are gone, the file is not.
   *
   * The store and the secret-file configuration come from one fresh module graph, so
   * each call is a session of its own, reading whatever the previous one left behind.
   */
  async function relaunch(options: { key: Buffer | null; isPackaged?: boolean }) {
    vi.resetModules();
    const core = await import('@magimail/core');
    core.configureSecretFiles({
      isPackaged: options.isPackaged ?? true,
      fetchKey: () => options.key,
      logger: silentLogger(),
    });
    return import('../src/settings-store.js');
  }

  beforeEach(() => {
    userData.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magical-settings-'));
  });

  afterEach(async () => {
    const core = await import('@magimail/core');
    core.resetSecretFiles();
    fs.rmSync(userData.dir, { recursive: true, force: true });
  });

  it('hands a saved setting back to the next launch', async () => {
    const first = await relaunch({ key: KEY });
    first.saveSetting('theme', 'dark');

    const second = await relaunch({ key: KEY });
    expect(second.loadSettings().theme).toBe('dark');
  });

  it('leaves nothing readable on disk on a packaged build', async () => {
    const store = await relaunch({ key: KEY });
    store.saveSetting('menuBarDisplayMode', 'dayAndMonth');

    const bytes = fs.readFileSync(settingsFile());
    expect(bytes.subarray(0, 6).toString()).toBe('MAGBOX');
    expect(bytes.includes('dayAndMonth')).toBe(false);
  });

  it('reads a file written before encryption and encrypts it on the next save', async () => {
    fs.writeFileSync(settingsFile(), JSON.stringify({ theme: 'dark' }), 'utf8');

    const store = await relaunch({ key: KEY });
    expect(store.loadSettings().theme).toBe('dark');

    store.saveSetting('hideSidebar', true);
    expect(fs.readFileSync(settingsFile()).subarray(0, 6).toString()).toBe('MAGBOX');
  });

  it('refuses to overwrite a file it could not read', async () => {
    const first = await relaunch({ key: KEY });
    first.saveSetting('theme', 'dark');
    const stored = fs.readFileSync(settingsFile());

    // What a restored machine looks like: the file survived, the keychain item did not.
    const second = await relaunch({ key: Buffer.alloc(32, 9) });
    expect(second.loadSettings().theme).toBe('system');
    second.saveSetting('theme', 'light');
    expect(fs.readFileSync(settingsFile())).toEqual(stored);

    // Every preference the user set is still there once the key is back.
    const third = await relaunch({ key: KEY });
    expect(third.loadSettings().theme).toBe('dark');
  });

  it('keeps a refused setting live for the rest of the session', async () => {
    const first = await relaunch({ key: KEY });
    first.saveSetting('theme', 'dark');

    const second = await relaunch({ key: Buffer.alloc(32, 9) });
    second.saveSetting('theme', 'light');
    // A setting that does not take effect until you restart reads as broken, and the
    // file is no worse off for a value this session never writes.
    expect(second.loadSettings().theme).toBe('light');
  });

  it('will not write plaintext over a file the packaged build encrypted', async () => {
    const packaged = await relaunch({ key: KEY });
    packaged.saveSetting('theme', 'dark');
    const stored = fs.readFileSync(settingsFile());

    // `pnpm dev` shares userData with the installed app, and the stock Electron binary
    // cannot reach the keychain at all.
    const development = await relaunch({ key: null, isPackaged: false });
    expect(development.loadSettings().theme).toBe('system');
    development.saveSetting('theme', 'light');

    expect(fs.readFileSync(settingsFile())).toEqual(stored);
  });
});
