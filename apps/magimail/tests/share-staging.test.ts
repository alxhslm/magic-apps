import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tempRoot = '';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tempRoot) },
}));

vi.mock('../src/native-widgets.js', () => ({
  groupContainerPath: vi.fn(() => null),
}));

import {
  copyIntoShareTempDir,
  createShareTempDir,
  removeShareTempDir,
  removeStagedShareFiles,
  sweepAbandonedShareStaging,
  writeIntoShareTempDir,
} from '../src/share-staging.js';

const HOUR_MS = 60 * 60 * 1000;
const UUID = '6f1c7a2e-9b3d-4f55-8a01-2d4e6f8a0b1c';

/** Pushes a directory's modification time back, so the sweep sees it as abandoned. */
function age(dir: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(dir, when, when);
}

function stage(container: string, name: string): string {
  const dir = path.join(container, 'SharedFiles', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'invoice.pdf'), 'staged');
  return dir;
}

describe('share staging', () => {
  let container = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'share-staging-test-'));
    container = fs.mkdtempSync(path.join(os.tmpdir(), 'share-group-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(container, { recursive: true, force: true });
  });

  describe('files it writes', () => {
    it('writes an exported thread readable only by its owner', async () => {
      const dir = createShareTempDir();
      const file = await writeIntoShareTempDir(dir, 'Quarterly review.pdf', Buffer.from('%PDF'));

      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it('drops the permissions a copied attachment arrived with', () => {
      const source = path.join(container, 'world-readable.txt');
      fs.writeFileSync(source, 'shared', { mode: 0o644 });

      const copied = copyIntoShareTempDir(source, createShareTempDir());

      expect(fs.readFileSync(copied, 'utf8')).toBe('shared');
      expect(fs.statSync(copied).mode & 0o777).toBe(0o600);
    });
  });

  describe('removing its own temp directories', () => {
    it('removes a directory it created', () => {
      const dir = createShareTempDir();
      removeShareTempDir(dir);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('refuses a directory it did not create', () => {
      const foreign = path.join(tempRoot, 'Documents');
      fs.mkdirSync(foreign);

      removeShareTempDir(foreign);

      expect(fs.existsSync(foreign)).toBe(true);
    });

    it('refuses a share-shaped directory outside the temp directory', () => {
      const elsewhere = path.join(container, 'magimail-share-1');
      fs.mkdirSync(elsewhere);

      removeShareTempDir(elsewhere);

      expect(fs.existsSync(elsewhere)).toBe(true);
    });
  });

  describe('removing what the Share extension staged', () => {
    it('removes the staging directory holding the files', () => {
      const dir = stage(container, UUID);

      removeStagedShareFiles([path.join(dir, 'invoice.pdf')], container);

      expect(fs.existsSync(dir)).toBe(false);
    });

    it('removes a directory once when several files name it', () => {
      const dir = stage(container, UUID);
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'staged');

      removeStagedShareFiles(
        [path.join(dir, 'invoice.pdf'), path.join(dir, 'notes.txt')],
        container,
      );

      expect(fs.existsSync(dir)).toBe(false);
    });

    // The file list comes from a magimail://share URL, which any process can open.
    it('refuses a path outside the container', () => {
      const elsewhere = path.join(container, 'Keychains');
      fs.mkdirSync(elsewhere);
      fs.writeFileSync(path.join(elsewhere, 'login.keychain'), 'secret');

      removeStagedShareFiles([path.join(elsewhere, 'login.keychain')], container);

      expect(fs.existsSync(elsewhere)).toBe(true);
    });

    it('refuses a directory under SharedFiles that is not named after a UUID', () => {
      const dir = stage(container, '..');
      removeStagedShareFiles([path.join(container, 'SharedFiles', '..', 'invoice.pdf')], container);
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('removes nothing when the build can claim no container', () => {
      const dir = stage(container, UUID);

      removeStagedShareFiles([path.join(dir, 'invoice.pdf')], null);

      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  describe('the startup sweep', () => {
    it('takes both kinds of staging an earlier run left behind', () => {
      const exported = createShareTempDir();
      age(exported, 2 * HOUR_MS);
      const staged = stage(container, UUID);
      age(staged, 2 * HOUR_MS);

      expect(sweepAbandonedShareStaging(container)).toBe(2);
      expect(fs.existsSync(exported)).toBe(false);
      expect(fs.existsSync(staged)).toBe(false);
    });

    // A share arriving while Magimail is closed launches it, so staging written seconds
    // ago is the share the sweep is racing.
    it('leaves staging that was written moments ago', () => {
      const exported = createShareTempDir();
      const staged = stage(container, UUID);

      expect(sweepAbandonedShareStaging(container)).toBe(0);
      expect(fs.existsSync(exported)).toBe(true);
      expect(fs.existsSync(staged)).toBe(true);
    });

    it('leaves everything else in the temp directory alone', () => {
      const foreign = path.join(tempRoot, 'com.apple.something');
      fs.mkdirSync(foreign);
      age(foreign, 2 * HOUR_MS);

      expect(sweepAbandonedShareStaging(container)).toBe(0);
      expect(fs.existsSync(foreign)).toBe(true);
    });

    it('sweeps only the temp directory when no container can be claimed', () => {
      const exported = createShareTempDir();
      age(exported, 2 * HOUR_MS);
      const staged = stage(container, UUID);
      age(staged, 2 * HOUR_MS);

      expect(sweepAbandonedShareStaging(null)).toBe(1);
      expect(fs.existsSync(exported)).toBe(false);
      expect(fs.existsSync(staged)).toBe(true);
    });
  });
});
