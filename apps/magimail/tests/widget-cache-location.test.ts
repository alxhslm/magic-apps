import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const warn = vi.fn();

vi.mock('@magimail/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn() }),
  redactText: (s: string) => s,
}));

const { widgetCachePath, resetWidgetCachePath, resetWidgetCacheContent, writeWidgetCache } =
  await import('../src/widget-cache.js');

/**
 * The snapshot moved out of Application Support because the read-only sandbox
 * exception that let the extension reach it covered the whole directory,
 * `Partitions/` and its session cookies included. These cover the rule that
 * replaced it: the App Group container is the only destination, and a build
 * that cannot claim the group writes nothing.
 */

let tmp: string;

beforeEach(() => {
  resetWidgetCachePath();
  resetWidgetCacheContent();
  warn.mockClear();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'magimail-group-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  resetWidgetCachePath();
  resetWidgetCacheContent();
});

const emptyCache = { updatedAt: 1, totalUnread: 0, accounts: [], messages: [] };

describe('where the snapshot goes', () => {
  it('uses the App Group container when one is vended', () => {
    expect(widgetCachePath(() => tmp)).toBe(path.join(tmp, 'widget-cache.json'));
  });

  it('has nowhere to write when no container is vended', () => {
    // An ad-hoc signature carries no team identifier and cannot claim the
    // group, which is the case this covers.
    expect(widgetCachePath(() => null)).toBeNull();
  });

  it('has nowhere to write rather than throwing when resolution itself fails', () => {
    expect(
      widgetCachePath(() => {
        throw new Error('addon missing');
      }),
    ).toBeNull();
  });

  it('resolves the container once, not on every poll', () => {
    const resolve = vi.fn(() => tmp);
    widgetCachePath(resolve);
    widgetCachePath(resolve);
    widgetCachePath(resolve);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('warns once, not on every poll, when there is no container', () => {
    const resolve = vi.fn(() => null);
    widgetCachePath(resolve);
    widgetCachePath(resolve);
    widgetCachePath(resolve);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('writing the snapshot', () => {
  it('writes into the group container', () => {
    writeWidgetCache(emptyCache, () => tmp);
    const written = path.join(tmp, 'widget-cache.json');
    expect(fs.existsSync(written)).toBe(true);
    expect(JSON.parse(fs.readFileSync(written, 'utf8')).updatedAt).toBe(1);
  });

  it('leaves no temp file behind, so the extension never reads a partial write', () => {
    writeWidgetCache(emptyCache, () => tmp);
    expect(fs.readdirSync(tmp)).toEqual(['widget-cache.json']);
  });

  it('writes nothing outside the container when none is vended', () => {
    // Application Support once took the overflow; nothing read it, and the
    // widget's placeholder is the right answer for a build without the group.
    const appSupport = path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Magimail',
      'widget-cache.json',
    );
    const before = fs.existsSync(appSupport);
    writeWidgetCache(emptyCache, () => null);
    expect(fs.existsSync(appSupport)).toBe(before);
  });

  it('does not throw when the destination is unwritable', () => {
    // A failed snapshot must not take down the poll that produced it.
    expect(() => writeWidgetCache(emptyCache, () => '/dev/null/nope')).not.toThrow();
  });
});
