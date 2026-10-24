import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('IcsHandler');

/**
 * ics-handler.ts
 *
 * Catches the `.ics` files macOS hands Magical, and holds them until there is something
 * to do with them.
 *
 * The queue is the whole reason this is a module. Double-clicking an invite while
 * Magical is closed launches it and fires `open-file` before `whenReady` — before the
 * window, the accounts and their partitions exist — so a handler registered at the usual
 * time is registered too late, and the file that started the app is the one file that
 * gets dropped. Registering the listener at import time and replaying what it caught is
 * what makes a cold double-click work.
 */

let handler: ((filePath: string) => void) | null = null;
const queued: string[] = [];

/**
 * Starts catching `open-file`.
 *
 * Called at module load rather than from `whenReady`; see above. macOS delivers files to
 * the running instance through this event whether or not Magical was already open, so
 * `argv` never has to be read.
 */
export function watchForIcsFiles(): void {
  app.on('open-file', (event, filePath) => {
    event.preventDefault();

    if (!isIcsPath(filePath)) {
      log.info('Ignoring an opened file that is not an .ics');
      return;
    }

    if (handler) handler(filePath);
    else queued.push(filePath);
  });
}

/** Installs the real handler and replays anything that arrived before it existed. */
export function onIcsFile(next: (filePath: string) => void): void {
  handler = next;
  const pending = queued.splice(0, queued.length);
  for (const filePath of pending) next(filePath);
}

function isIcsPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.ics';
}

/**
 * Reads the file, or returns null when it cannot be.
 *
 * Read here rather than handed to Google as a path alone because the picker names what
 * is about to be imported, and because a file that has already been moved or deleted
 * should fail before the user is asked which account to put it in.
 */
export function readIcsFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    log.error('Could not read the opened .ics file:', error);
    return null;
  }
}
