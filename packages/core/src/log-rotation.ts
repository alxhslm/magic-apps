import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Rotation and retention for the log directory.
 *
 * Separate from `logger.ts` because that module cannot be loaded outside
 * Electron -- and this is the half with rules worth testing. electron-log
 * rotates on size alone and keeps a single `.old` file; the retention window
 * the product promises is a week, which is this file's job.
 */

export const RETENTION_DAYS = 7;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** `main.2026-09-14.log`, and `main.2026-09-14.1.log` for a second rotation. */
const ARCHIVE_PATTERN = /^main\.\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/;

/**
 * A free archive name for a log being rotated out on `now`.
 *
 * Dated rather than numbered, because "which day did this happen" is the first
 * question asked of an archive and a bare `.old` cannot answer it.
 */
export function archiveNameFor(dir: string, ext: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 10);
  let target = path.join(dir, `main.${stamp}${ext}`);
  let suffix = 1;
  // Rotating twice in one day would otherwise overwrite the earlier archive.
  while (fs.existsSync(target)) {
    target = path.join(dir, `main.${stamp}.${suffix}${ext}`);
    suffix += 1;
  }
  return target;
}

/**
 * Deletes archives older than the retention window.
 *
 * Matches only the archive pattern, so an unrelated file that finds its way
 * into the directory is left alone -- this runs against a directory in the
 * user's Library, and deleting by age alone would be reckless.
 *
 * Never throws: it is called from inside a log write, and a failed sweep must
 * not take logging down with it.
 */
export function sweepArchives(dir: string, now: number = Date.now()): string[] {
  const removed: string[] = [];
  try {
    const cutoff = now - RETENTION_MS;
    for (const name of fs.readdirSync(dir)) {
      if (!ARCHIVE_PATTERN.test(name)) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed.push(name);
        }
      } catch {
        // A file that vanished under us, or one we may not stat. Skip it.
      }
    }
  } catch {
    // A missing or unreadable directory is not worth failing a write over.
  }
  return removed;
}

/** True for a name this module would consider one of its own archives. */
export function isArchiveName(name: string): boolean {
  return ARCHIVE_PATTERN.test(name);
}
