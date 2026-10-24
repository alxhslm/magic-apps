import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseWindow } from 'electron';
import { TOOLBAR_HEIGHT } from '@magimail/core';
import {
  attachNativeToolbar,
  onNativeToolbarAction,
  setNativeToolbarMode,
} from '../src/native-toolbar.js';
import { loadAddon, setActionHandler, toolbarManager } from '../src/native-addon.js';

vi.mock('electron', () => ({}));

vi.mock('../src/native-addon.js', () => ({
  loadAddon: vi.fn(() => ({ attach: vi.fn() })),
  loadedAddon: vi.fn(),
  setActionHandler: vi.fn(),
  toolbarManager: { updateLabels: vi.fn() },
}));

function fakeWindow() {
  return {
    getNativeWindowHandle: vi.fn().mockReturnValue(Buffer.alloc(8)),
    setSheetOffset: vi.fn(),
  } as unknown as BaseWindow & { setSheetOffset: ReturnType<typeof vi.fn> };
}

describe('magical native toolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('anchors sheets below the toolbar band', () => {
    const window = fakeWindow();

    attachNativeToolbar(window);

    expect(window.setSheetOffset).toHaveBeenCalledWith(TOOLBAR_HEIGHT);
  });

  // The addon is a dylib, not a bundle, so it has nowhere to read a String
  // Catalog from. The labels are pushed before attach, so the items AppKit
  // builds already carry them.
  it('pushes the toolbar labels before attaching', () => {
    attachNativeToolbar(fakeWindow());

    expect(toolbarManager.updateLabels).toHaveBeenCalledWith(
      expect.objectContaining({ 'toolbar.search': 'Search', 'toolbar.newTask': 'New Task' }),
    );
  });

  it('registers action handler for native actions', () => {
    const handler = vi.fn();
    onNativeToolbarAction(handler);
    expect(setActionHandler).toHaveBeenCalledWith(handler);
  });

  it('dims the grid items in Tasks mode and re-enables them in Calendar mode', () => {
    const setItemEnabled = vi.fn();
    vi.mocked(loadAddon).mockReturnValue({ setItemEnabled } as never);

    setNativeToolbarMode('tasks');
    expect(setItemEnabled).toHaveBeenCalledWith('navGroup', false);
    expect(setItemEnabled).toHaveBeenCalledWith('search', false);

    setItemEnabled.mockClear();
    setNativeToolbarMode('calendar');
    expect(setItemEnabled).toHaveBeenCalledWith('navGroup', true);
    expect(setItemEnabled).toHaveBeenCalledWith('search', true);
  });
});
