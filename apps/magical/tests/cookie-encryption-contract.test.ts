import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Chromium session cookies contain live Google tokens (SID, HSID, SSID, SAPISID).
 * Electron gates Chromium's OSCrypt Keychain encryption behind the
 * EnableCookieEncryption build fuse. Without it, cookies are written in plaintext
 * to SQLite on disk.
 *
 * This test guards the electron-builder packaging contract: the fuse must be
 * explicitly enabled so electron-builder flips the fuse bit before code signing.
 */
describe('cookie encryption packaging contract', () => {
  it('enables the EnableCookieEncryption fuse in electron-builder.json', () => {
    const builderPath = path.resolve(__dirname, '../electron-builder.json');
    const builder = JSON.parse(readFileSync(builderPath, 'utf8')) as {
      electronFuses?: {
        enableCookieEncryption?: boolean;
      };
    };

    expect(
      builder.electronFuses,
      'electronFuses block is missing from electron-builder.json',
    ).toBeDefined();
    expect(
      builder.electronFuses?.enableCookieEncryption,
      'enableCookieEncryption must be true so Chromium session cookies are encrypted with macOS Keychain',
    ).toBe(true);
  });
});
