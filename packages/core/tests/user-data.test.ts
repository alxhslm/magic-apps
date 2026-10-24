import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { isDemoMode, resolveUserDataPath } from '../src/user-data.js';

describe('resolveUserDataPath', () => {
  const appDataPath = '/mock/Library/Application Support';

  it('returns default path when no args or env vars are provided', () => {
    const result = resolveUserDataPath({
      appName: 'Magimail',
      appDataPath,
      argv: ['node', 'main.js'],
      env: {},
    });
    expect(result).toBe(path.join(appDataPath, 'Magimail'));
  });

  it('prefers app-specific environment variable over default', () => {
    const custom = '/custom/data/magimail';
    const result = resolveUserDataPath({
      appName: 'Magimail',
      appDataPath,
      argv: ['node', 'main.js'],
      env: { MAGIMAIL_USER_DATA_DIR: custom },
    });
    expect(result).toBe(path.resolve(custom));
  });

  it('respects MAGIC_SUITE_USER_DATA_DIR as a fallback environment variable', () => {
    const custom = '/shared/custom/suite';
    const result = resolveUserDataPath({
      appName: 'Magical',
      appDataPath,
      argv: ['node', 'main.js'],
      env: { MAGIC_SUITE_USER_DATA_DIR: custom },
    });
    expect(result).toBe(path.resolve(custom));
  });

  it('supports --user-data-dir CLI argument', () => {
    const custom = '/tmp/magimail-profile';
    const result = resolveUserDataPath({
      appName: 'Magimail',
      appDataPath,
      argv: ['node', 'main.js', `--user-data-dir=${custom}`],
      env: {},
    });
    expect(result).toBe(path.resolve(custom));
  });

  it('supports --profile CLI argument for named profiles', () => {
    const result = resolveUserDataPath({
      appName: 'Magimail',
      appDataPath,
      argv: ['node', 'main.js', '--profile=demo'],
      env: {},
    });
    expect(result).toBe(path.join(appDataPath, 'Magimail-demo'));
  });

  it('resolves --demo to the demo profile', () => {
    const result = resolveUserDataPath({
      appName: 'Magical',
      appDataPath,
      argv: ['node', 'main.js', '--demo'],
      env: {},
    });
    expect(result).toBe(path.join(appDataPath, 'Magical-demo'));
  });

  it('gives precedence to environment variable over CLI arguments', () => {
    const envPath = '/env/path';
    const cliPath = '/cli/path';
    const result = resolveUserDataPath({
      appName: 'Magimail',
      appDataPath,
      argv: ['node', 'main.js', `--user-data-dir=${cliPath}`],
      env: { MAGIMAIL_USER_DATA_DIR: envPath },
    });
    expect(result).toBe(path.resolve(envPath));
  });
});

describe('isDemoMode', () => {
  it('is off for an ordinary run', () => {
    expect(isDemoMode(['node', 'main.js'], {})).toBe(false);
  });

  it('accepts the explicit --demo flag', () => {
    expect(isDemoMode(['node', 'main.js', '--demo'], {})).toBe(true);
  });

  it('still accepts --profile=demo, the spelling the screenshot skill uses', () => {
    expect(isDemoMode(['node', 'main.js', '--profile=demo'], {})).toBe(true);
  });

  it('reads the flag the main process sets for the helper', () => {
    expect(isDemoMode(['node', 'main.js'], { MAGIC_SUITE_DEMO: '1' })).toBe(true);
  });

  it('is off for another profile', () => {
    expect(isDemoMode(['node', 'main.js', '--profile=work'], {})).toBe(false);
  });
});
