import { describe, it, expect, vi } from 'vitest';
import type { BaseWindow } from 'electron';
import { TOOLBAR_HEIGHT } from '@magimail/core';
import { attachNativeToolbar, onNativeToolbarAction } from '../src/native-toolbar.js';
import { setActionHandler, toolbarManager } from '../src/native-addon.js';

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

describe('native toolbar', () => {
  // Without the offset the Customize Toolbar palette covers the toolbar it is
  // customising: Electron anchors sheets to the top of the content view, which
  // spans the titlebar on a hiddenInset window.
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
      expect.objectContaining({ 'toolbar.search': 'Search', 'toolbar.newMessage': 'New Message' }),
    );
  });

  it('registers action handler for native actions', () => {
    const handler = vi.fn();
    onNativeToolbarAction(handler);
    expect(setActionHandler).toHaveBeenCalledWith(handler);
  });
});
