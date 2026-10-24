import { describe, it, expect, vi, beforeEach } from 'vitest';

const { spawn, unref, readdirSync, info } = vi.hoisted(() => ({
  spawn: vi.fn(),
  unref: vi.fn(),
  readdirSync: vi.fn(),
  info: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn }));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readdirSync,
}));
vi.mock('../src/logger.js', () => ({ createLogger: () => ({ info }) }));

const { removalTargets, deferredRemovalShell, scheduleRemoval } =
  await import('../src/app-removal.js');

/** Every path here is invented: no real account, user or team identifier. */
const HOME = '/Users/example';
const BUNDLE_ID = 'com.example.app';
const GROUP_CONTAINER = `${HOME}/Library/Group Containers/<TEAM>.com.example.app`;

function input(overrides: Partial<Parameters<typeof removalTargets>[0]> = {}) {
  return {
    appName: 'Example',
    bundleId: BUNDLE_ID,
    home: HOME,
    userDataPath: `${HOME}/Library/Application Support/Example`,
    logsPath: `${HOME}/Library/Logs/Example`,
    groupContainerPath: GROUP_CONTAINER,
    ...overrides,
  };
}

const EXPECTED_PATHS = [
  `${HOME}/Library/Application Support/Example`,
  `${HOME}/Library/Logs/Example`,
  GROUP_CONTAINER,
  `${HOME}/Library/Preferences/com.example.app.plist`,
  `${HOME}/Library/Caches/com.example.app`,
  `${HOME}/Library/WebKit/com.example.app`,
  `${HOME}/Library/HTTPStorages/com.example.app`,
  `${HOME}/Library/Saved Application State/com.example.app.savedState`,
];

/** A path built to break anything that interpolates it into a shell script. */
const STRANGE_PATH = `${HOME}/Library/Caches/My App/$(rm -rf ~);"quoted"`;

describe('removalTargets', () => {
  it('lists every on-disk residue of the install, in removal order', () => {
    expect(removalTargets(input()).paths).toEqual(EXPECTED_PATHS);
  });

  it('omits the App Group container when the app has none', () => {
    const paths = removalTargets(input({ groupContainerPath: null })).paths;

    expect(paths).toHaveLength(EXPECTED_PATHS.length - 1);
    expect(paths).not.toContain(GROUP_CONTAINER);
  });

  it('de-duplicates, keeping the first position of a repeated path', () => {
    // A dev run can put the logs beside the userData directory; the same path must
    // not be handed to the shell twice.
    const paths = removalTargets(input({ logsPath: input().userDataPath })).paths;

    expect(paths).toEqual(EXPECTED_PATHS.filter((p) => p !== `${HOME}/Library/Logs/Example`));
  });

  it('names the containers glob and the preferences domain for the bundle', () => {
    const targets = removalTargets(input());

    expect(targets.containerGlob).toBe(`${HOME}/Library/Containers/com.example.app.*`);
    expect(targets.preferencesDomain).toBe(BUNDLE_ID);
  });

  it('preserves every keychain item by naming none to delete', () => {
    // The list holds the services a removal must not touch. It stays empty while no
    // keychain item exists to preserve, and a non-empty list is a deliberate change.
    expect(removalTargets(input()).keychainServicesToPreserve).toEqual([]);
  });
});

describe('deferredRemovalShell', () => {
  it('waits on the pid, shifts, and removes each remaining positional', () => {
    const script = deferredRemovalShell(4242, ['/tmp/a'], BUNDLE_ID);

    expect(script).toContain('while kill -0 "$1" 2>/dev/null && [ "$i" -lt 300 ]; do');
    expect(script).toContain('shift');
    expect(script).toContain('rm -rf -- "$p"');
  });

  it('bounds the wait so a prevented quit cannot sleep forever', () => {
    const script = deferredRemovalShell(4242, ['/tmp/a'], BUNDLE_ID);

    // 300 * 0.2s, after which the removal runs anyway rather than never.
    expect(script).toContain('[ "$i" -lt 300 ]');
  });

  it('clears the preferences domain only when the env var is non-empty', () => {
    const script = deferredRemovalShell(4242, [], BUNDLE_ID);

    expect(script).toContain('${REMOVAL_PREFS_DOMAIN:-}');
    expect(script).toContain('/usr/bin/defaults delete "$REMOVAL_PREFS_DOMAIN"');
  });

  it('never interpolates a path or the domain into the script text', () => {
    const script = deferredRemovalShell(4242, [STRANGE_PATH], BUNDLE_ID);

    expect(script).not.toContain(STRANGE_PATH);
    expect(script).not.toContain('My App');
    expect(script).not.toContain(BUNDLE_ID);
  });
});

describe('scheduleRemoval', () => {
  beforeEach(() => {
    spawn.mockReset().mockReturnValue({ unref });
    unref.mockReset();
    info.mockReset();
    readdirSync.mockReset().mockReturnValue([]);
  });

  it('spawns a detached shell carrying the pid and every path as argv', () => {
    scheduleRemoval(input());

    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, argv, options] = spawn.mock.calls[0];
    expect(file).toBe('/bin/sh');
    expect(argv.slice(0, 4)).toEqual(['-c', expect.any(String), 'sh', String(process.pid)]);
    expect(argv.slice(4)).toEqual(removalTargets(input()).paths);
    expect(options).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(options.env.REMOVAL_PREFS_DOMAIN).toBe(BUNDLE_ID);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('keeps a path with spaces and shell metacharacters verbatim in the argv', () => {
    scheduleRemoval(input({ userDataPath: STRANGE_PATH }));

    const argv: string[] = spawn.mock.calls[0][1];
    expect(argv).toContain(STRANGE_PATH);
    expect(argv[1]).not.toContain(STRANGE_PATH);
  });

  it('sweeps the extension containers the glob matches', () => {
    readdirSync.mockReturnValue(['com.example.app.widget', 'com.example.app', 'com.other.app']);

    scheduleRemoval(input());

    expect(readdirSync).toHaveBeenCalledWith(`${HOME}/Library/Containers`);
    const argv: string[] = spawn.mock.calls[0][1];
    expect(argv.slice(4)).toEqual([
      ...removalTargets(input()).paths,
      `${HOME}/Library/Containers/com.example.app.widget`,
    ]);
  });

  it('still schedules the removal when there is no Containers directory', () => {
    readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    expect(() => scheduleRemoval(input())).not.toThrow();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
