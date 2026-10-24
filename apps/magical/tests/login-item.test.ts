import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';
import { isOpenAtLogin, applyLaunchAtLogin, reconcileLaunchAtLogin } from '../src/login-item.js';
import { loadSettings, saveSetting } from '../src/settings-store.js';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/magical-test-userdata'),
    getLoginItemSettings: vi.fn(),
    setLoginItemSettings: vi.fn(),
  },
}));

vi.mock('../src/settings-store.js', () => ({
  loadSettings: vi.fn(),
  saveSetting: vi.fn(),
}));

function osSays(openAtLogin: boolean) {
  vi.mocked(app.getLoginItemSettings).mockReturnValue({
    openAtLogin,
  } as ReturnType<typeof app.getLoginItemSettings>);
}

function storedSays(launchAtLogin: boolean) {
  vi.mocked(loadSettings).mockReturnValue({ launchAtLogin } as ReturnType<typeof loadSettings>);
}

/**
 * Every function under test is gated on macOS, so the platform has to be pinned
 * rather than inherited; CI runs these on Linux, where an unpinned suite would
 * exercise nothing but the early returns.
 */
function pretendPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('Launch at login', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    pretendPlatform('darwin');
  });

  afterEach(() => {
    pretendPlatform(originalPlatform);
  });

  it('reports the current macOS login item state', () => {
    osSays(true);
    expect(isOpenAtLogin()).toBe(true);

    osSays(false);
    expect(isOpenAtLogin()).toBe(false);
  });

  it('registers the login item when enabled', () => {
    applyLaunchAtLogin(true);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });

  it('removes the login item when disabled', () => {
    applyLaunchAtLogin(false);
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
  });

  it('leaves the login item alone off macOS, where there is none', () => {
    pretendPlatform('linux');
    storedSays(true);
    osSays(true);

    expect(isOpenAtLogin()).toBe(false);
    applyLaunchAtLogin(true);
    expect(reconcileLaunchAtLogin()).toBe(false);

    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    expect(saveSetting).not.toHaveBeenCalled();
  });

  describe('startup reconciliation', () => {
    it('leaves the setting alone when it already matches the OS', () => {
      storedSays(true);
      osSays(true);

      expect(reconcileLaunchAtLogin()).toBe(true);
      expect(saveSetting).not.toHaveBeenCalled();
    });

    it('adopts the OS value when the user removed the login item externally', () => {
      storedSays(true);
      osSays(false);

      expect(reconcileLaunchAtLogin()).toBe(false);
      expect(saveSetting).toHaveBeenCalledWith('launchAtLogin', false);
    });

    it('adopts the OS value when the login item was added externally', () => {
      storedSays(false);
      osSays(true);

      expect(reconcileLaunchAtLogin()).toBe(true);
      expect(saveSetting).toHaveBeenCalledWith('launchAtLogin', true);
    });

    it('never writes the stored value back to the OS', () => {
      storedSays(true);
      osSays(false);

      reconcileLaunchAtLogin();
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    });
  });
});
