import { describe, it, expect, vi } from 'vitest';
import type { BaseWindow, Rectangle } from 'electron';
import { WindowRebuilder } from '../src/window.js';

const BOUNDS: Rectangle = { x: 100, y: 60, width: 1280, height: 820 };

interface Harness {
  rebuilder: WindowRebuilder<{ getActiveAccountId: () => string }>;
  build: ReturnType<typeof vi.fn>;
  log: { info: ReturnType<typeof vi.fn> };
  /** Fires the window's `closed`, which is what a real close does. */
  closeWindow: () => void;
  window: { close: ReturnType<typeof vi.fn> };
  setWindow: (value: BaseWindow | null) => void;
  setManager: (value: { getActiveAccountId: () => string } | null) => void;
  setQuitting: (value: boolean) => void;
}

function setup(options: { quitting?: boolean; withWindow?: boolean; withManager?: boolean } = {}) {
  let quitting = options.quitting ?? false;
  let closed: (() => void) | undefined;

  // `close()` does not fire `closed` here: a real window emits it once the OS has
  // taken the window away, which is why the rebuild waits for it.
  const window = {
    close: vi.fn(),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'closed') closed = handler;
    }),
    getBounds: () => BOUNDS,
  } as unknown as BaseWindow;

  const manager = { getActiveAccountId: () => 'account_one' };
  let currentWindow: BaseWindow | null = options.withWindow === false ? null : window;
  let currentManager = options.withManager === false ? null : manager;

  const build = vi.fn();
  const log = { info: vi.fn() };

  const rebuilder = new WindowRebuilder({
    window: () => currentWindow,
    manager: () => currentManager,
    accountId: (m) => m.getActiveAccountId(),
    quitting: () => quitting,
    build,
    log,
  });

  const harness: Harness = {
    rebuilder,
    build,
    log,
    closeWindow: () => closed?.(),
    window,
    setWindow: (value) => {
      currentWindow = value;
    },
    setManager: (value) => {
      currentManager = value;
    },
    setQuitting: (value) => {
      quitting = value;
    },
  };
  return harness;
}

describe('rebuilding the main window', () => {
  it('closes the old window, then builds the replacement on the same account and bounds', () => {
    const harness = setup();

    expect(harness.rebuilder.rebuild('reload requested')).toBe(true);
    expect(harness.window.close).toHaveBeenCalledTimes(1);
    // Not before the window is gone: its `closed` handler clears the app's handles.
    expect(harness.build).not.toHaveBeenCalled();

    harness.closeWindow();

    expect(harness.build).toHaveBeenCalledWith('account_one', BOUNDS);
  });

  it('names the reason, and the detail when there is one', () => {
    const harness = setup();

    harness.rebuilder.rebuild('reload requested');
    expect(harness.log.info).toHaveBeenCalledWith('Rebuilding the window: reload requested');

    harness.closeWindow();
    harness.rebuilder.rebuild('account view stopped presenting', 'no frame');
    expect(harness.log.info).toHaveBeenLastCalledWith(
      'Rebuilding the window: account view stopped presenting (no frame)',
    );
  });

  it('reports a rebuild in progress, which a close handler has to let through', () => {
    const harness = setup();

    expect(harness.rebuilder.isRebuilding()).toBe(false);
    harness.rebuilder.rebuild('reload requested');
    expect(harness.rebuilder.isRebuilding()).toBe(true);

    harness.closeWindow();
    expect(harness.rebuilder.isRebuilding()).toBe(false);
  });

  it('does nothing without a window', () => {
    const harness = setup({ withWindow: false });

    expect(harness.rebuilder.rebuild('reload requested')).toBe(false);
    expect(harness.build).not.toHaveBeenCalled();
  });

  it('does nothing without a manager', () => {
    const harness = setup({ withManager: false });

    expect(harness.rebuilder.rebuild('reload requested')).toBe(false);
    expect(harness.window.close).not.toHaveBeenCalled();
  });

  it('does nothing once the app is quitting', () => {
    const harness = setup({ quitting: true });

    expect(harness.rebuilder.rebuild('reload requested')).toBe(false);
    expect(harness.window.close).not.toHaveBeenCalled();
  });

  it('refuses a second rebuild while one is running', () => {
    const harness = setup();

    expect(harness.rebuilder.rebuild('reload requested')).toBe(true);
    expect(harness.rebuilder.rebuild('reload requested')).toBe(false);
    expect(harness.window.close).toHaveBeenCalledTimes(1);
  });

  it('does not build a replacement when the app starts quitting mid-rebuild', () => {
    const harness = setup();

    harness.rebuilder.rebuild('reload requested');
    harness.setQuitting(true);
    harness.closeWindow();

    expect(harness.build).not.toHaveBeenCalled();
  });

  it('rebuilds again after a completed rebuild, on the window that replaced it', () => {
    const harness = setup();

    harness.rebuilder.rebuild('reload requested');
    harness.closeWindow();

    // What the app's `build` does: the replacement becomes the window to read.
    const replacement = {
      close: vi.fn(),
      once: vi.fn(),
      getBounds: () => BOUNDS,
    } as unknown as BaseWindow;
    harness.setWindow(replacement);

    expect(harness.rebuilder.rebuild('reload requested')).toBe(true);
    expect(harness.window.close).toHaveBeenCalledTimes(1);
    expect(replacement.close).toHaveBeenCalledTimes(1);
    expect(harness.rebuilder.isRebuilding()).toBe(true);
  });
});
