import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LogSink } from './types.js';

/**
 * Encrypted local cache files.
 *
 * Every file this module writes is AES-256-GCM over the UTF-8 JSON, under a
 * 32-byte key held in the login keychain. The layout is pinned, because the
 * Swift helper and the extensions read and write the same files:
 *
 *     offset 0   "MAGBOX"     6 bytes, ASCII
 *     offset 6   0x01         format version
 *     offset 7   nonce        12 random bytes
 *     offset 19  ciphertext   AES-256-GCM over the UTF-8 JSON
 *     end - 16   tag          16 bytes
 *
 * The file's basename is the additional authenticated data, so one file's
 * ciphertext cannot be swapped into another's place.
 *
 * Reads accept a legacy plaintext JSON file and writes always encrypt, which is
 * what migrates a machine on first launch after the update.
 */

const MAGIC = Buffer.from('MAGBOX', 'ascii');
const FORMAT_VERSION = 1;
const HEADER_LENGTH = MAGIC.length + 1;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MIN_ENCRYPTED_LENGTH = HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH;

/** Why a file that exists could not be turned back into a value. */
export type SecretFileFailure = 'undecryptable' | 'malformed';

/**
 * A file exists but yielded no value.
 *
 * Callers fail closed on this: caches discard and rebuild, and settings and
 * accounts refuse to read and refuse to overwrite for the rest of the session,
 * so an unreadable file never becomes a destroyed one. Falling back to reading
 * the bytes as plaintext would hand an attacker who replaced the file exactly
 * the result they wanted.
 */
export class SecretFileUnreadableError extends Error {
  constructor(
    readonly filePath: string,
    readonly reason: SecretFileFailure,
    options?: { cause?: unknown },
  ) {
    super(`Cannot read ${path.basename(filePath)}: ${reason}`, options);
    this.name = 'SecretFileUnreadableError';
  }
}

/** The keychain holds no usable key, so nothing can be read or written. */
export class SecretKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretKeyUnavailableError';
  }
}

export interface SecretFileConfig {
  /**
   * True on a packaged build. An unpackaged build reads and writes plaintext
   * and never asks for the key. It runs the stock Electron binary, which is
   * not the app the keychain item was created for, and `pnpm dev` shares its
   * userData directory with the installed app.
   */
  isPackaged: boolean;
  /** Returns the 32-byte key from the keychain, creating it on first use. */
  fetchKey: () => Buffer | null;
  logger?: LogSink;
}

let config: SecretFileConfig | null = null;
let cachedKey: Buffer | null = null;

/**
 * Names the build and the key source for the rest of the process.
 *
 * Call this once at startup, before anything reads a cache file. Electron and
 * the native addon stay on the app side of the boundary: this module is handed
 * the answers rather than asking for them.
 */
export function configureSecretFiles(next: SecretFileConfig): void {
  config = next;
  cachedKey = null;
  if (!next.isPackaged) {
    (next.logger ?? console).warn(
      '[SecretFile] Unpackaged build: local cache files are plaintext and the keychain is not used.',
    );
  }
}

/** Forgets the configuration, so a later read has to be told again. */
export function resetSecretFiles(): void {
  config = null;
  cachedKey = null;
}

/** True when files are encrypted. False on an unpackaged build. */
export function isProtectedBuild(): boolean {
  return config?.isPackaged === true;
}

/**
 * The key, fetched once and held for the life of the process.
 *
 * The keychain call crosses into `securityd`, and a settings write that happens
 * on every keystroke cannot afford that each time.
 */
function key(): Buffer {
  if (cachedKey) return cachedKey;
  if (!config) {
    throw new SecretKeyUnavailableError('Secret files used before configureSecretFiles');
  }

  const fetched = config.fetchKey();
  if (!fetched) {
    throw new SecretKeyUnavailableError('The keychain returned no local cache key');
  }
  if (fetched.length !== KEY_LENGTH) {
    throw new SecretKeyUnavailableError(
      `Local cache key is ${fetched.length} bytes, expected ${KEY_LENGTH}`,
    );
  }

  cachedKey = fetched;
  return cachedKey;
}

/** True when the bytes carry the magic and version this module writes. */
function isEncrypted(buf: Buffer): boolean {
  return (
    buf.length >= HEADER_LENGTH &&
    buf.subarray(0, MAGIC.length).equals(MAGIC) &&
    buf[MAGIC.length] === FORMAT_VERSION
  );
}

function encrypt(plaintext: Buffer, aad: string): Buffer {
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), nonce, body, cipher.getAuthTag()]);
}

function decrypt(buf: Buffer, aad: string): Buffer {
  const nonce = buf.subarray(HEADER_LENGTH, HEADER_LENGTH + NONCE_LENGTH);
  const body = buf.subarray(HEADER_LENGTH + NONCE_LENGTH, buf.length - TAG_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * The value in `filePath`, or null when there is no file.
 *
 * Reads either form: a file written by this module, or a legacy plaintext JSON
 * one. Throws `SecretFileUnreadableError` when a file exists and does not yield
 * a value, so a caller cannot mistake damage for absence.
 */
export function readSecretFile<T>(filePath: string): T | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  let json: string;
  if (isEncrypted(buf)) {
    if (buf.length < MIN_ENCRYPTED_LENGTH) {
      throw new SecretFileUnreadableError(filePath, 'undecryptable');
    }
    try {
      json = decrypt(buf, path.basename(filePath)).toString('utf8');
    } catch (err) {
      if (err instanceof SecretKeyUnavailableError) throw err;
      throw new SecretFileUnreadableError(filePath, 'undecryptable', { cause: err });
    }
  } else {
    json = buf.toString('utf8');
  }

  try {
    return JSON.parse(json) as T;
  } catch (err) {
    throw new SecretFileUnreadableError(filePath, 'malformed', { cause: err });
  }
}

/**
 * Writes `value` as JSON, encrypted on a packaged build and plaintext otherwise.
 *
 * Through a temporary file, so a crash mid-write leaves the previous file
 * rather than a truncated one; a half-written encrypted file yields nothing at
 * all, where a half-written plaintext one at least yielded a parse error.
 */
export function writeSecretFile(filePath: string, value: unknown): void {
  // Compact: nobody reads a sealed file by eye, and the event cache is rewritten
  // on every poll.
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const bytes = isProtectedBuild() ? encrypt(json, path.basename(filePath)) : json;

  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, bytes, { mode: 0o600 });
  // The mode above only applies to a file this call creates, and a temp file
  // left by an earlier crash is not one.
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, filePath);
}
