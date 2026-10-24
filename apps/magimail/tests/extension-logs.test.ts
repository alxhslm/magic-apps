import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncExtensionLogs } from '../src/extension-logs.js';

describe('syncExtensionLogs', () => {
  let tmpDir: string;
  let groupDir: string;
  let targetDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magimail-logs-test-'));
    groupDir = path.join(tmpDir, 'group-container');
    targetDir = path.join(tmpDir, 'target-logs');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does nothing when the group container cannot be resolved', () => {
    const copied = syncExtensionLogs(targetDir, () => null);
    expect(copied).toEqual([]);
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it('does nothing when the logs directory does not exist in the group container', () => {
    fs.mkdirSync(groupDir, { recursive: true });
    const copied = syncExtensionLogs(targetDir, () => groupDir);
    expect(copied).toEqual([]);
    expect(fs.existsSync(targetDir)).toBe(false);
  });

  it('copies .log files into targetDir beside main.log', () => {
    const groupLogs = path.join(groupDir, 'logs');
    fs.mkdirSync(groupLogs, { recursive: true });
    fs.writeFileSync(path.join(groupLogs, 'share-extension.log'), 'log data 1', 'utf8');
    fs.writeFileSync(path.join(groupLogs, 'share-extension.old.log'), 'old log data', 'utf8');

    const copied = syncExtensionLogs(targetDir, () => groupDir);

    expect(copied).toEqual([
      path.join(targetDir, 'share-extension.log'),
      path.join(targetDir, 'share-extension.old.log'),
    ]);
    expect(fs.readFileSync(path.join(targetDir, 'share-extension.log'), 'utf8')).toBe('log data 1');
    expect(fs.readFileSync(path.join(targetDir, 'share-extension.old.log'), 'utf8')).toBe(
      'old log data',
    );
  });

  it('ignores non-log files in the group logs directory', () => {
    const groupLogs = path.join(groupDir, 'logs');
    fs.mkdirSync(groupLogs, { recursive: true });
    fs.writeFileSync(path.join(groupLogs, 'share-extension.log'), 'log data', 'utf8');
    fs.writeFileSync(path.join(groupLogs, '.DS_Store'), 'junk', 'utf8');
    fs.writeFileSync(path.join(groupLogs, 'metadata.json'), '{}', 'utf8');

    const copied = syncExtensionLogs(targetDir, () => groupDir);

    expect(copied).toEqual([path.join(targetDir, 'share-extension.log')]);
    expect(fs.existsSync(path.join(targetDir, '.DS_Store'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'metadata.json'))).toBe(false);
  });

  it('overwrites existing target files with newer versions', () => {
    const groupLogs = path.join(groupDir, 'logs');
    fs.mkdirSync(groupLogs, { recursive: true });
    fs.mkdirSync(targetDir, { recursive: true });

    fs.writeFileSync(path.join(targetDir, 'share-extension.log'), 'stale version', 'utf8');
    fs.writeFileSync(path.join(groupLogs, 'share-extension.log'), 'fresh version', 'utf8');

    syncExtensionLogs(targetDir, () => groupDir);

    expect(fs.readFileSync(path.join(targetDir, 'share-extension.log'), 'utf8')).toBe(
      'fresh version',
    );
  });

  it('handles read or copy errors gracefully without throwing', () => {
    const resolveBroken = () => {
      throw new Error('Kernel entitlement error');
    };

    expect(() => syncExtensionLogs(targetDir, resolveBroken)).not.toThrow();
  });
});
