import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import { app, dialog } from 'electron';
import {
  canRemoveAllAppData,
  removeAllAppDataAndQuit,
  REMOVE_ALL_ENV_VAR,
} from '../src/remove-all-data.js';
import { isDemoMode, scheduleRemoval, setOpenAtLogin } from '@magimail/core';
import { sendToHelper } from '../src/swift-helper.js';
import { appGroupContainerPath } from '../src/native-widgets.js';

vi.mock('electron', () => ({
  app: {
    name: 'Magimail',
    isPackaged: true,
    getPath: vi.fn(),
    quit: vi.fn(),
  },
  dialog: {
    showMessageBox: vi.fn(),
  },
}));

// The whole of core is replaced: only these three functions are reached, and the
// real `scheduleRemoval` would spawn a shell that waits for this test process.
vi.mock('@magimail/core', () => ({
  isDemoMode: vi.fn(() => false),
  scheduleRemoval: vi.fn(),
  setOpenAtLogin: vi.fn(),
}));

vi.mock('@magimail/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../src/swift-helper.js', () => ({
  sendToHelper: vi.fn(),
}));

vi.mock('../src/native-widgets.js', () => ({
  appGroupContainerPath: vi.fn(),
}));

/** Placeholder paths, in the shape macOS uses, so nothing here names a real Mac. */
const APP_DATA = '/tmp/removal-home/Library/Application Support';
const DEFAULT_USER_DATA = `${APP_DATA}/Magimail`;
const LOGS = '/tmp/removal-home/Library/Logs/Magimail';
const GROUP_CONTAINER =
  '/tmp/removal-home/Library/Group Containers/TEAM123456.group.com.alexhaslam.magimail';

function pretendPaths({
  userData = DEFAULT_USER_DATA,
  appData = APP_DATA,
  logs = LOGS,
} = {}): void {
  vi.mocked(app.getPath).mockImplementation((name) => {
    if (name === 'appData') return appData;
    if (name === 'userData') return userData;
    if (name === 'logs') return logs;
    throw new Error(`unexpected path in this test: ${name}`);
  });
}

function pretendPackaged(isPackaged: boolean): void {
  Object.defineProperty(app, 'isPackaged', { value: isPackaged, configurable: true });
}

function answerDialog(response: number): void {
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response, checkboxChecked: false });
}

describe('canRemoveAllAppData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pretendPaths();
    pretendPackaged(true);
    vi.mocked(isDemoMode).mockReturnValue(false);
  });

  it('offers removal on a normal installed launch', () => {
    expect(canRemoveAllAppData({})).toBe(true);
  });

  it('refuses an unpackaged run', () => {
    pretendPackaged(false);
    expect(canRemoveAllAppData({})).toBe(false);
  });

  it('refuses a run whose userData is a profile of its own', () => {
    pretendPaths({ userData: `${APP_DATA}/Magimail-work` });
    expect(canRemoveAllAppData({})).toBe(false);
  });

  it('refuses a demo run', () => {
    vi.mocked(isDemoMode).mockReturnValue(true);
    expect(canRemoveAllAppData({})).toBe(false);
  });

  it('is bypassed by the E2E override', () => {
    pretendPackaged(false);
    expect(canRemoveAllAppData({ [REMOVE_ALL_ENV_VAR]: '1' })).toBe(true);
  });
});

describe('removeAllAppDataAndQuit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pretendPaths();
    pretendPackaged(true);
    vi.mocked(isDemoMode).mockReturnValue(false);
    vi.mocked(sendToHelper).mockResolvedValue(null);
    vi.mocked(appGroupContainerPath).mockReturnValue(GROUP_CONTAINER);
  });

  it('asks first, with Cancel as both the default and the cancel button', async () => {
    answerDialog(0);

    await removeAllAppDataAndQuit();

    const options = vi.mocked(dialog.showMessageBox).mock.calls[0][0];
    expect(options.buttons).toEqual(['Cancel', 'Remove All Data and Quit']);
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    expect(options.detail).toContain('quit');
  });

  it('leaves everything alone when the user cancels', async () => {
    answerDialog(0);

    await removeAllAppDataAndQuit();

    expect(setOpenAtLogin).not.toHaveBeenCalled();
    expect(sendToHelper).not.toHaveBeenCalled();
    expect(scheduleRemoval).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
  });

  it('hands the whole install to core and quits', async () => {
    answerDialog(1);

    await removeAllAppDataAndQuit();

    expect(setOpenAtLogin).toHaveBeenCalledWith(false);
    expect(sendToHelper).toHaveBeenCalledWith('notify.clearAll');
    expect(scheduleRemoval).toHaveBeenCalledWith({
      appName: 'Magimail',
      bundleId: 'com.alexhaslam.magimail',
      home: os.homedir(),
      userDataPath: DEFAULT_USER_DATA,
      logsPath: LOGS,
      groupContainerPath: GROUP_CONTAINER,
    });
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('never aims at the real App Group container in a demo run', async () => {
    answerDialog(1);
    vi.mocked(isDemoMode).mockReturnValue(true);

    await removeAllAppDataAndQuit();

    expect(scheduleRemoval).toHaveBeenCalledWith(
      expect.objectContaining({ groupContainerPath: null }),
    );
  });

  it('still removes and quits when the helper cannot answer', async () => {
    answerDialog(1);
    vi.mocked(sendToHelper).mockRejectedValue(new Error('helper gone'));

    await removeAllAppDataAndQuit();

    expect(scheduleRemoval).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('still removes and quits when the login item cannot be cleared', async () => {
    answerDialog(1);
    vi.mocked(setOpenAtLogin).mockImplementation(() => {
      throw new Error('login item refused');
    });

    await removeAllAppDataAndQuit();

    expect(scheduleRemoval).toHaveBeenCalledTimes(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
  });

  it('still quits when the removal cannot be scheduled', async () => {
    answerDialog(1);
    vi.mocked(scheduleRemoval).mockImplementation(() => {
      throw new Error('spawn refused');
    });

    await removeAllAppDataAndQuit();

    expect(app.quit).toHaveBeenCalledTimes(1);
  });
});
