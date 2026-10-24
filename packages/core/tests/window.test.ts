import { describe, it, expect } from 'vitest';
import { createMainWindowOptions, viewIsAlive } from '../src/window.js';
import type { WebContentsView } from 'electron';

/** A view standing in for the real one, with only the property viewIsAlive reads. */
function fakeView(webContents: { isDestroyed: () => boolean } | undefined): WebContentsView {
  return { webContents } as unknown as WebContentsView;
}

describe('viewIsAlive', () => {
  it('is false for a missing view', () => {
    expect(viewIsAlive(undefined)).toBe(false);
    expect(viewIsAlive(null)).toBe(false);
  });

  it("is false once Electron has dropped the view's webContents", () => {
    // The regression: `view.webContents` reads back undefined after the webContents is
    // destroyed, so `!view.webContents.isDestroyed()` throws instead of answering. A
    // released view must read as not-alive, not crash the caller that asks.
    expect(() => viewIsAlive(fakeView(undefined))).not.toThrow();
    expect(viewIsAlive(fakeView(undefined))).toBe(false);
  });

  it("follows the webContents' own destroyed state", () => {
    expect(viewIsAlive(fakeView({ isDestroyed: () => true }))).toBe(false);
    expect(viewIsAlive(fakeView({ isDestroyed: () => false }))).toBe(true);
  });
});

describe('createMainWindowOptions', () => {
  it('generates BaseWindow defaults matching macOS HIG specifications', () => {
    const opts = createMainWindowOptions({
      title: 'Test App',
      width: 1280,
      height: 850,
      minWidth: 960,
      minHeight: 600,
    });

    expect(opts.vibrancy).toBe('sidebar');
    expect(opts.visualEffectState).toBe('active');
    expect(opts.backgroundColor).toBe('#00000000');
    expect(opts.width).toBe(1280);
    expect(opts.height).toBe(850);
    expect(opts.minWidth).toBe(960);
    expect(opts.minHeight).toBe(600);
    expect(opts.title).toBe('Test App');
    expect(opts.show).toBe(false);
  });

  it('allows overriding specific window options', () => {
    const opts = createMainWindowOptions({
      title: 'Custom App',
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 700,
    });

    expect(opts.width).toBe(1440);
    expect(opts.height).toBe(900);
    expect(opts.minWidth).toBe(1024);
    expect(opts.minHeight).toBe(700);
    expect(opts.title).toBe('Custom App');
    expect(opts.vibrancy).toBe('sidebar');
  });
});
