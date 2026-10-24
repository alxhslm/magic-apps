import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  configureSecretFiles,
  isProtectedBuild,
  readSecretFile,
  resetSecretFiles,
  SecretFileUnreadableError,
  writeSecretFile,
} from '../src/secret-file.js';

/**
 * Exercised against real files under a real key: the thing under test is what
 * lands on disk and whether it comes back, and a mocked `fs` or a mocked cipher
 * would only assert that this file's own assumptions hold.
 */

const KEY = Buffer.alloc(32, 7);

let dir: string;
let keyFetches: number;

/** Configures a packaged build, counting how often the keychain is asked. */
function packagedBuild(key: Buffer = KEY): void {
  keyFetches = 0;
  configureSecretFiles({
    isPackaged: true,
    fetchKey: () => {
      keyFetches += 1;
      return key;
    },
    logger: silentLogger(),
  });
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function file(name: string): string {
  return path.join(dir, name);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magimail-secret-'));
  packagedBuild();
});

afterEach(() => {
  resetSecretFiles();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a packaged build', () => {
  it('reads back what it wrote', () => {
    writeSecretFile(file('settings.json'), { theme: 'dark', accounts: [1, 2, 3] });
    expect(readSecretFile(file('settings.json'))).toEqual({
      theme: 'dark',
      accounts: [1, 2, 3],
    });
  });

  it('leaves no plaintext on disk', () => {
    writeSecretFile(file('settings.json'), { token: 'sekrit' });
    const bytes = fs.readFileSync(file('settings.json'));
    expect(bytes.subarray(0, 7)).toEqual(Buffer.from('MAGBOX\x01', 'binary'));
    expect(bytes.includes('sekrit')).toBe(false);
  });

  it('gives each write a fresh nonce', () => {
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    const first = fs.readFileSync(file('settings.json'));
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    const second = fs.readFileSync(file('settings.json'));
    expect(first.subarray(7, 19)).not.toEqual(second.subarray(7, 19));
  });

  it('asks the keychain once however many files it touches', () => {
    writeSecretFile(file('settings.json'), { a: 1 });
    writeSecretFile(file('widget-cache.json'), { b: 2 });
    readSecretFile(file('settings.json'));
    expect(keyFetches).toBe(1);
  });

  it('returns null for a file that is not there', () => {
    expect(readSecretFile(file('missing.json'))).toBeNull();
  });

  it('reports itself as protected', () => {
    expect(isProtectedBuild()).toBe(true);
  });
});

describe('migration from plaintext', () => {
  it('reads a legacy file written before encryption', () => {
    fs.writeFileSync(file('settings.json'), JSON.stringify({ theme: 'light' }), 'utf8');
    expect(readSecretFile(file('settings.json'))).toEqual({ theme: 'light' });
  });

  it('encrypts the legacy file on the next write', () => {
    fs.writeFileSync(file('settings.json'), JSON.stringify({ theme: 'light' }), 'utf8');
    const migrated = readSecretFile<{ theme: string }>(file('settings.json'));
    writeSecretFile(file('settings.json'), migrated);

    expect(fs.readFileSync(file('settings.json')).subarray(0, 6).toString()).toBe('MAGBOX');
    expect(readSecretFile(file('settings.json'))).toEqual({ theme: 'light' });
  });

  it('refuses a legacy file that is not JSON', () => {
    fs.writeFileSync(file('settings.json'), '{ half-written', 'utf8');
    expect(() => readSecretFile(file('settings.json'))).toThrow(SecretFileUnreadableError);
  });
});

describe('a file that has been interfered with', () => {
  it('refuses one with a flipped byte in the ciphertext', () => {
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    const bytes = fs.readFileSync(file('settings.json'));
    bytes[25] ^= 0x01;
    fs.writeFileSync(file('settings.json'), bytes);

    expect(() => readSecretFile(file('settings.json'))).toThrow(SecretFileUnreadableError);
  });

  it('refuses one whose bytes came from another file', () => {
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    fs.copyFileSync(file('settings.json'), file('accounts.json'));

    expect(() => readSecretFile(file('accounts.json'))).toThrow(SecretFileUnreadableError);
  });

  it('refuses one written under a different key', () => {
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    packagedBuild(Buffer.alloc(32, 9));

    expect(() => readSecretFile(file('settings.json'))).toThrow(SecretFileUnreadableError);
  });

  it('refuses a header with nothing behind it', () => {
    fs.writeFileSync(file('settings.json'), Buffer.from('MAGBOX\x01', 'binary'));
    expect(() => readSecretFile(file('settings.json'))).toThrow(SecretFileUnreadableError);
  });

  it('says why it refused, so callers can tell damage from absence', () => {
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    const bytes = fs.readFileSync(file('settings.json'));
    bytes[25] ^= 0x01;
    fs.writeFileSync(file('settings.json'), bytes);

    try {
      readSecretFile(file('settings.json'));
      expect.unreachable('a tampered file must not read');
    } catch (err) {
      expect(err).toBeInstanceOf(SecretFileUnreadableError);
      expect((err as SecretFileUnreadableError).reason).toBe('undecryptable');
      expect((err as SecretFileUnreadableError).filePath).toBe(file('settings.json'));
    }
  });
});

describe('an unpackaged build', () => {
  beforeEach(() => {
    configureSecretFiles({
      isPackaged: false,
      fetchKey: () => {
        throw new Error('the keychain must not be touched on an unpackaged build');
      },
      logger: silentLogger(),
    });
  });

  it('writes plaintext JSON and never asks for a key', () => {
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    expect(JSON.parse(fs.readFileSync(file('settings.json'), 'utf8'))).toEqual({ theme: 'dark' });
    expect(readSecretFile(file('settings.json'))).toEqual({ theme: 'dark' });
  });

  it('reports itself as unprotected', () => {
    expect(isProtectedBuild()).toBe(false);
  });

  it('warns once at startup', () => {
    const warnings: unknown[][] = [];
    configureSecretFiles({
      isPackaged: false,
      fetchKey: () => null,
      logger: { info: () => {}, warn: (...args) => warnings.push(args), error: () => {} },
    });
    expect(warnings).toHaveLength(1);
  });

  it('refuses an encrypted file rather than handing back its bytes', () => {
    packagedBuild();
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    configureSecretFiles({
      isPackaged: false,
      fetchKey: () => null,
      logger: silentLogger(),
    });

    expect(() => readSecretFile(file('settings.json'))).toThrow();
  });
});

describe('file permissions', () => {
  it('writes an encrypted file only its owner can read', () => {
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    expect(fs.statSync(file('settings.json')).mode & 0o777).toBe(0o600);
  });

  it('tightens a file that was world-readable before', () => {
    fs.writeFileSync(file('settings.json'), '{}', { mode: 0o644 });
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    expect(fs.statSync(file('settings.json')).mode & 0o777).toBe(0o600);
  });

  it('leaves no temporary file behind', () => {
    writeSecretFile(file('settings.json'), { theme: 'dark' });
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });
});

describe('the pinned format', () => {
  /**
   * The Swift side holds this same vector in `SecretFileTests.swift`. Both
   * implementations write files the other has to read, and a drift in either
   * direction should fail here rather than on someone's widget.
   */
  const VECTOR = 'TUFHQk9YAQABAgMEBQYHCAkKCzwgonOgiKc5t2Pz6sOCWhDP4p14pNZjfLFDfVHnxxXQ';
  const VECTOR_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

  it('opens a file sealed by the Swift implementation', () => {
    packagedBuild(VECTOR_KEY);
    fs.writeFileSync(file('settings.json'), Buffer.from(VECTOR, 'base64'));

    expect(readSecretFile(file('settings.json'))).toEqual({ theme: 'dark' });
  });
});
