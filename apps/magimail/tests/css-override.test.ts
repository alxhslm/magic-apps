import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initCssOverride,
  getCssOverride,
  watchCssOverride,
  stopCssOverride,
} from '../src/css-override.js';

vi.mock('@magimail/core/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

function tempCss(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magimail-css-'));
  const file = path.join(dir, 'gmail.css');
  fs.writeFileSync(file, contents);
  return file;
}

afterEach(() => stopCssOverride());

describe('css override', () => {
  it('is inert without the flag', () => {
    expect(initCssOverride(['/bin/electron', '.'])).toBeNull();
    expect(getCssOverride()).toBeNull();
  });

  it('reads the override file when the flag is passed', () => {
    const file = tempCss('body { color: red; }');
    initCssOverride(['--css-override=' + file]);
    expect(getCssOverride()).toBe('body { color: red; }');
  });

  it('picks up edits without re-initialising', () => {
    const file = tempCss('a {}');
    initCssOverride(['--css-override=' + file]);
    expect(getCssOverride()).toBe('a {}');
    fs.writeFileSync(file, 'b {}');
    expect(getCssOverride()).toBe('b {}');
  });

  it('keeps the last good CSS when the file disappears mid-edit', () => {
    const file = tempCss('a {}');
    initCssOverride(['--css-override=' + file]);
    expect(getCssOverride()).toBe('a {}');
    fs.rmSync(file);
    // An unreadable override must never blank the page.
    expect(getCssOverride()).toBe('a {}');
  });

  it('ignores the flag when given no path', () => {
    expect(initCssOverride(['--css-override='])).toBeNull();
    expect(getCssOverride()).toBeNull();
  });

  it('notifies on save, debounced', () => {
    vi.useFakeTimers();
    let watcherCb: ((event: string, filename: string) => void) | undefined;
    vi.spyOn(fs, 'watch').mockImplementation((_dir: any, cb: any) => {
      watcherCb = cb;
      return { close: vi.fn() } as any;
    });

    const file = tempCss('a {}');
    initCssOverride(['--css-override=' + file]);
    let calls = 0;
    watchCssOverride(() => {
      calls += 1;
    });

    expect(watcherCb).toBeDefined();
    fs.writeFileSync(file, 'b {}');
    watcherCb!('change', path.basename(file));

    fs.writeFileSync(file, 'c {}');
    watcherCb!('change', path.basename(file));

    // Debounce window is 120ms; callback should not fire prematurely
    vi.advanceTimersByTime(100);
    expect(calls).toBe(0);

    // After debounce expires, exactly one call is made
    vi.advanceTimersByTime(25);
    expect(calls).toBe(1);
    expect(getCssOverride()).toBe('c {}');

    vi.useRealTimers();
  });

  it('survives an atomic save that replaces the file', () => {
    vi.useFakeTimers();
    let watcherCb: ((event: string, filename: string) => void) | undefined;
    vi.spyOn(fs, 'watch').mockImplementation((_dir: any, cb: any) => {
      watcherCb = cb;
      return { close: vi.fn() } as any;
    });

    const file = tempCss('a {}');
    initCssOverride(['--css-override=' + file]);
    let calls = 0;
    watchCssOverride(() => {
      calls += 1;
    });

    // How editors actually save: write a sibling, then rename over the target.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, 'renamed {}');
    fs.renameSync(tmp, file);

    watcherCb!('rename', path.basename(file));
    vi.advanceTimersByTime(120);

    expect(calls).toBe(1);
    expect(getCssOverride()).toBe('renamed {}');

    vi.useRealTimers();
  });
});
