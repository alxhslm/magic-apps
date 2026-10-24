import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  archiveNameFor,
  isArchiveName,
  sweepArchives,
  RETENTION_DAYS,
  RETENTION_MS,
} from '../src/log-rotation.js';

/**
 * Exercised against a real directory rather than a mocked `fs`: the thing under
 * test is what happens to files on disk, and a mock would only assert that the
 * calls were made in the order this file already assumes.
 */

let dir: string;

/** Writes `name` and back-dates it by `ageDays`. */
function writeAged(name: string, ageDays: number): string {
  const full = path.join(dir, name);
  fs.writeFileSync(full, 'x');
  const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  fs.utimesSync(full, when, when);
  return full;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magimail-logs-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('archiveNameFor', () => {
  it('names an archive for the day it was rotated', () => {
    const name = archiveNameFor(dir, '.log', new Date('2026-09-14T10:00:00Z'));
    expect(path.basename(name)).toBe('main.2026-09-14.log');
  });

  it('does not overwrite an archive already made today', () => {
    fs.writeFileSync(path.join(dir, 'main.2026-09-14.log'), 'first');
    const name = archiveNameFor(dir, '.log', new Date('2026-09-14T11:00:00Z'));
    expect(path.basename(name)).toBe('main.2026-09-14.1.log');
  });

  it('keeps counting when several rotations land on one day', () => {
    fs.writeFileSync(path.join(dir, 'main.2026-09-14.log'), 'a');
    fs.writeFileSync(path.join(dir, 'main.2026-09-14.1.log'), 'b');
    const name = archiveNameFor(dir, '.log', new Date('2026-09-14T12:00:00Z'));
    expect(path.basename(name)).toBe('main.2026-09-14.2.log');
  });
});

describe('sweepArchives', () => {
  it('deletes an archive past the retention window', () => {
    writeAged('main.2026-09-01.log', RETENTION_DAYS + 1);
    expect(sweepArchives(dir)).toEqual(['main.2026-09-01.log']);
    expect(fs.existsSync(path.join(dir, 'main.2026-09-01.log'))).toBe(false);
  });

  it('keeps an archive inside the window', () => {
    writeAged('main.2026-09-13.log', RETENTION_DAYS - 1);
    expect(sweepArchives(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'main.2026-09-13.log'))).toBe(true);
  });

  it('never deletes the live log, however old it is', () => {
    writeAged('main.log', RETENTION_DAYS * 10);
    sweepArchives(dir);
    expect(fs.existsSync(path.join(dir, 'main.log'))).toBe(true);
  });

  it('leaves files it did not write alone', () => {
    // The directory is in the user's Library. Deleting by age alone would
    // eventually delete something that was not ours.
    writeAged('important-notes.txt', RETENTION_DAYS * 10);
    writeAged('renderer.log', RETENTION_DAYS * 10);
    sweepArchives(dir);
    expect(fs.existsSync(path.join(dir, 'important-notes.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'renderer.log'))).toBe(true);
  });

  it('sweeps a suffixed archive too', () => {
    writeAged('main.2026-09-01.2.log', RETENTION_DAYS + 1);
    expect(sweepArchives(dir)).toEqual(['main.2026-09-01.2.log']);
  });

  it('returns empty rather than throwing when the directory is absent', () => {
    expect(sweepArchives(path.join(dir, 'does-not-exist'))).toEqual([]);
  });

  it('honours an injected clock, so retention is not tied to the wall clock', () => {
    writeAged('main.2026-09-10.log', 3);
    // Ten days later the same file is past the window.
    const later = Date.now() + 10 * 24 * 60 * 60 * 1000;
    expect(sweepArchives(dir, later)).toEqual(['main.2026-09-10.log']);
  });
});

describe('isArchiveName', () => {
  it.each([
    ['main.2026-09-14.log', true],
    ['main.2026-09-14.1.log', true],
    ['main.log', false],
    ['main.old.log', false],
    ['renderer.2026-09-14.log', false],
    ['main.2026-09-14.log.bak', false],
  ])('%s -> %s', (name, expected) => {
    expect(isArchiveName(name)).toBe(expected);
  });
});

describe('the retention window the product promises', () => {
  it('is seven days', () => {
    expect(RETENTION_DAYS).toBe(7);
    expect(RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
