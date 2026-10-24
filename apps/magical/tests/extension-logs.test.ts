import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncExtensionLogs } from '../src/extension-logs.js';

/**
 * The widgets extension is sandboxed and can only write into the App Group
 * container, so without this fold a "my widget is blank" report arrives with
 * `main.log` and without the file naming the missing cache.
 */

describe('syncExtensionLogs', () => {
  let tmpDir: string;
  let groupDir: string;
  let targetDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magical-logs-test-'));
    groupDir = path.join(tmpDir, 'group-container');
    targetDir = path.join(tmpDir, 'target-logs');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('copies the widgets log in beside main.log', () => {
    const groupLogs = path.join(groupDir, 'logs');
    fs.mkdirSync(groupLogs, { recursive: true });
    fs.writeFileSync(path.join(groupLogs, 'widgets-extension.log'), 'cache missing', 'utf8');

    const copied = syncExtensionLogs(targetDir, () => groupDir);

    expect(copied).toEqual([path.join(targetDir, 'widgets-extension.log')]);
    expect(fs.readFileSync(path.join(targetDir, 'widgets-extension.log'), 'utf8')).toBe(
      'cache missing',
    );
  });

  it('replaces a stale copy rather than leaving it', () => {
    const groupLogs = path.join(groupDir, 'logs');
    fs.mkdirSync(groupLogs, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'widgets-extension.log'), 'stale', 'utf8');
    fs.writeFileSync(path.join(groupLogs, 'widgets-extension.log'), 'fresh', 'utf8');

    syncExtensionLogs(targetDir, () => groupDir);

    expect(fs.readFileSync(path.join(targetDir, 'widgets-extension.log'), 'utf8')).toBe('fresh');
  });

  it('ignores anything that is not a log', () => {
    const groupLogs = path.join(groupDir, 'logs');
    fs.mkdirSync(groupLogs, { recursive: true });
    fs.writeFileSync(path.join(groupLogs, 'widgets-extension.log'), 'data', 'utf8');
    fs.writeFileSync(path.join(groupLogs, 'events.json'), '{}', 'utf8');

    const copied = syncExtensionLogs(targetDir, () => groupDir);

    expect(copied).toEqual([path.join(targetDir, 'widgets-extension.log')]);
    expect(fs.existsSync(path.join(targetDir, 'events.json'))).toBe(false);
  });

  it('creates no directory when there is no container to read', () => {
    expect(syncExtensionLogs(targetDir, () => null)).toEqual([]);
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it('does not throw when the container cannot be resolved', () => {
    expect(() =>
      syncExtensionLogs(targetDir, () => {
        throw new Error('Kernel entitlement error');
      }),
    ).not.toThrow();
  });
});
