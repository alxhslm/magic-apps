import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { configureSecretFiles, resetSecretFiles, writeSecretFile } from '@magimail/core';
import { ThemeManager } from '../src/theme-manager.js';
import { nativeTheme } from 'electron';

let userData: string;
let preferencePath: string;

vi.mock('electron', () => ({
  nativeTheme: {
    themeSource: 'system',
    shouldUseDarkColors: false,
    on: vi.fn(),
  },
  app: {
    getPath: vi.fn(() => userData),
  },
}));

const KEY = Buffer.alloc(32, 3);
const OTHER_KEY = Buffer.alloc(32, 4);

function packagedBuild(key: Buffer): void {
  configureSecretFiles({
    isPackaged: true,
    fetchKey: () => key,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'magimail-theme-'));
  preferencePath = path.join(userData, 'theme-preference.json');
  resetSecretFiles();
  vi.clearAllMocks();
});

afterEach(() => {
  resetSecretFiles();
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('ThemeManager', () => {
  it('initializes with default system theme', () => {
    const manager = new ThemeManager();
    expect(manager.getTheme()).toBe('system');
  });

  it('switches theme to dark and sets nativeTheme.themeSource', () => {
    const manager = new ThemeManager();
    manager.setTheme('dark');
    expect(manager.getTheme()).toBe('dark');
    expect(nativeTheme.themeSource).toBe('dark');
    expect(manager.isDark()).toBe(true);
  });

  it('switches theme to light and sets nativeTheme.themeSource', () => {
    const manager = new ThemeManager();
    manager.setTheme('light');
    expect(manager.getTheme()).toBe('light');
    expect(nativeTheme.themeSource).toBe('light');
    expect(manager.isDark()).toBe(false);
  });

  it('loads saved theme preference from storage if present', () => {
    writeSecretFile(preferencePath, { theme: 'dark' });
    expect(new ThemeManager().getTheme()).toBe('dark');
  });

  it('reads a preference left as plaintext by an older build', () => {
    fs.writeFileSync(preferencePath, JSON.stringify({ theme: 'dark' }), 'utf8');
    expect(new ThemeManager().getTheme()).toBe('dark');
  });

  it('carries a choice across a restart on a packaged build', () => {
    packagedBuild(KEY);
    new ThemeManager().setTheme('dark');
    expect(fs.readFileSync(preferencePath).includes('dark')).toBe(false);
    expect(new ThemeManager().getTheme()).toBe('dark');
  });

  it('falls back to system when the preference will not decrypt', () => {
    packagedBuild(OTHER_KEY);
    writeSecretFile(preferencePath, { theme: 'dark' });
    resetSecretFiles();
    packagedBuild(KEY);

    expect(new ThemeManager().getTheme()).toBe('system');
  });

  it('replaces a preference that will not decrypt with the next choice', () => {
    packagedBuild(OTHER_KEY);
    writeSecretFile(preferencePath, { theme: 'dark' });
    resetSecretFiles();
    packagedBuild(KEY);

    new ThemeManager().setTheme('light');
    expect(new ThemeManager().getTheme()).toBe('light');
  });
});
