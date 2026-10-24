import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const { info, theme, displays, primary, readFileSync } = vi.hoisted(() => ({
  info: vi.fn(),
  theme: { shouldUseDarkColors: true, shouldUseHighContrastColors: false, themeSource: 'system' },
  displays: [{}, {}],
  primary: { size: { width: 1512, height: 982 }, scaleFactor: 2 },
  readFileSync: vi.fn(),
}));

// The plist and the OS version are stubbed because the CI runner for these
// tests is Linux: reading the real host would assert whatever machine happens
// to run them rather than what the banner builds.
vi.mock('node:fs', () => ({ readFileSync, renameSync: vi.fn() }));

vi.mock('electron', () => ({
  nativeTheme: theme,
  screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => primary },
}));

vi.mock('electron-log/main', () => ({
  default: {
    scope: () => ({ info }),
    transports: {
      file: { getFile: () => ({ path: '/tmp/main.log' }), transforms: [] },
      console: {},
    },
  },
}));

const { logStartupBanner, logDisplayEnvironment } = await import('../src/logger.js');

/**
 * The two lines a bug report is read against. Everything below them is only
 * interpretable once you know which OS and which appearance produced it.
 */

const PLIST = [
  '<key>ProductVersion</key>',
  '<string>15.6.1</string>',
  '<key>ProductBuildVersion</key>',
  '<string>24G90</string>',
].join('\n');

const realSystemVersion = process.getSystemVersion;

beforeEach(() => {
  info.mockClear();
  readFileSync.mockReset();
  readFileSync.mockReturnValue(PLIST);
  process.getSystemVersion = () => '15.6.1';
});

afterAll(() => {
  process.getSystemVersion = realSystemVersion;
});

describe('logStartupBanner', () => {
  it('names the macOS build alongside the version', () => {
    logStartupBanner('Magical', '1.2.3');

    // Apple ships several builds under one version string, so the version alone
    // does not identify the OS a reporter is running.
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain('15.6.1 (24G90)');
  });

  it('falls back to the version alone when the plist cannot be read', () => {
    readFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    logStartupBanner('Magical', '1.2.3');

    const line = info.mock.calls[0][0] as string;
    expect(line).toContain('15.6.1');
    expect(line).not.toContain('(24G90)');
  });

  it('carries the app version and every runtime version', () => {
    logStartupBanner('Magical', '1.2.3');

    const line = info.mock.calls[0][0] as string;
    expect(line).toContain('Magical 1.2.3');
    expect(line).toContain(`electron ${process.versions.electron}`);
    expect(line).toContain(`chrome ${process.versions.chrome}`);
    expect(line).toContain(`node ${process.versions.node}`);
    expect(line).toContain(process.arch);
  });
});

describe('logDisplayEnvironment', () => {
  it('records the resolved appearance, the chosen source, and the primary display', () => {
    logDisplayEnvironment();

    // Both facts, because a Mac that turned dark at sunset and a user who chose
    // dark look identical from `shouldUseDarkColors` alone.
    expect(info).toHaveBeenCalledWith(
      'dark appearance (theme system), 2 display(s), primary 1512x982 @2x',
    );
  });

  it('follows the appearance when the user forces one', () => {
    theme.shouldUseDarkColors = false;
    theme.themeSource = 'light';

    logDisplayEnvironment();

    expect(info.mock.calls[0][0]).toContain('light appearance (theme light)');

    theme.shouldUseDarkColors = true;
    theme.themeSource = 'system';
  });

  it('says so when high contrast is on', () => {
    theme.shouldUseHighContrastColors = true;

    logDisplayEnvironment();

    expect(info.mock.calls[0][0]).toContain('high contrast');

    theme.shouldUseHighContrastColors = false;
  });
});
