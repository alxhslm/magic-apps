import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import { createLogger, redactText } from '@magimail/core/logger';
import { appGroupContainerPath } from './native-widgets.js';

const log = createLogger('ShareStaging');

/**
 * share-staging.ts
 *
 * Owns every path a share writes to, and the rules for taking it back.
 *
 * Both halves of sharing put readable mail on disk. An outbound share renders the thread
 * to a PDF the sharing service reads from; an inbound share arrives as files the Share
 * extension has already copied into the App Group container. Neither is content the app
 * needs after the operation that created it, so this module is the one place that makes
 * them, and the one place that removes them.
 *
 * Removal is guarded rather than trusted. The inbound file list arrives from a
 * `magimail://share` URL, and any process on the machine can open one of those with any
 * path in it, so a path is deleted only once it has been shown to be staging of ours:
 * a `magimail-share-*` directory directly under the temp directory, or a
 * `SharedFiles/<uuid>/` directory directly under our own App Group container. Anything
 * else is refused and logged.
 */

/** Names the directories this module creates under the OS temp directory. */
const TEMP_PREFIX = 'magimail-share-';

/** Where the Share extension stages what it was handed, inside the App Group container. */
const STAGING_DIR = 'SharedFiles';

/** The extension names each staging directory after a fresh UUID. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How stale staging has to be before the startup sweep will take it.
 *
 * A share that arrives while Magimail is closed launches it, so the files the sweep is
 * about to walk past can be the very ones the share is waiting to attach. An hour is far
 * longer than that gap and far shorter than the days a leaked directory survives.
 */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

/** Owner-only, so a readable thread is never wider than the user who shared it. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** `/var/…` and `/private/var/…` are the same directory; compare them resolved. */
function resolved(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** Creates a private directory for one share. */
export function createShareTempDir(): string {
  const dir = path.join(app.getPath('temp'), `${TEMP_PREFIX}${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

/** Copies a file into staging, owner-readable only. */
export function copyIntoShareTempDir(source: string, dir: string): string {
  const dest = path.join(dir, path.basename(source));
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, FILE_MODE);
  return dest;
}

/** Writes a file into staging, owner-readable only. */
export async function writeIntoShareTempDir(
  dir: string,
  name: string,
  contents: Buffer,
): Promise<string> {
  const dest = path.join(dir, name);
  await fs.promises.writeFile(dest, contents, { mode: FILE_MODE });
  return dest;
}

/** Whether `dir` is a `magimail-share-*` directory directly under the temp directory. */
function isOwnTempDir(dir: string): boolean {
  const target = resolved(dir);
  const temp = resolved(app.getPath('temp'));
  if (!target || !temp) return false;
  return path.dirname(target) === temp && path.basename(target).startsWith(TEMP_PREFIX);
}

/** Removes a directory this module created. Refuses anything else. */
export function removeShareTempDir(dir: string): void {
  if (!isOwnTempDir(dir)) {
    log.warn('Refusing to remove a path that is not share staging:', redactText(dir));
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    log.warn('Could not remove share staging:', error);
  }
}

/** Where the Share extension stages files, or null when this build cannot claim the group. */
function stagingRoot(container?: string | null): string | null {
  const root = container === undefined ? appGroupContainerPath() : container;
  return root ? path.join(root, STAGING_DIR) : null;
}

/**
 * Whether `dir` is a `SharedFiles/<uuid>/` directory of our own App Group container.
 *
 * Fails closed: a build with no entitlement for the group resolves no container, and so
 * can prove nothing about the path it was handed and removes nothing.
 */
function isStagedShareDir(dir: string, container?: string | null): boolean {
  const root = stagingRoot(container);
  if (!root) return false;
  const target = resolved(dir);
  const resolvedRoot = resolved(root);
  if (!target || !resolvedRoot) return false;
  return path.dirname(target) === resolvedRoot && UUID_PATTERN.test(path.basename(target));
}

/**
 * Removes the staging directories holding `filePaths`, once they have been copied out.
 *
 * Takes the whole list because the extension stages one share into one directory, so
 * several paths usually name the same directory and it should be removed once.
 */
export function removeStagedShareFiles(filePaths: string[], container?: string | null): void {
  const dirs = new Set(filePaths.map((filePath) => path.dirname(filePath)));
  for (const dir of dirs) {
    if (!isStagedShareDir(dir, container)) {
      log.info('Leaving a shared file that was not staged by the extension');
      continue;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      log.warn('Could not remove extension staging:', error);
    }
  }
}

/** Whether nothing has been written to `dir` for long enough to call it abandoned. */
function abandoned(dir: string, now: number): boolean {
  try {
    return now - fs.statSync(dir).mtimeMs > ABANDONED_AFTER_MS;
  } catch {
    return false;
  }
}

function sweepDirectory(parent: string, keep: (name: string) => boolean, now: number): number {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !keep(entry.name)) continue;
    const dir = path.join(parent, entry.name);
    if (!abandoned(dir, now)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch (error) {
      log.warn('Could not remove abandoned staging:', error);
    }
  }
  return removed;
}

/**
 * Clears staging that earlier runs left behind, of both kinds.
 *
 * Runs once at startup, so a build that stops the leak also takes back what the builds
 * before it lost. A crash between staging a file and sharing it leaves the same debris,
 * and this is what collects it.
 */
export function sweepAbandonedShareStaging(container?: string | null): number {
  const now = Date.now();
  let removed = sweepDirectory(app.getPath('temp'), (name) => name.startsWith(TEMP_PREFIX), now);

  const root = stagingRoot(container);
  if (root) removed += sweepDirectory(root, (name) => UUID_PATTERN.test(name), now);

  if (removed > 0) log.info(`Removed ${removed} abandoned share staging director(ies)`);
  return removed;
}
