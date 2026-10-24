import { BaseWindow } from 'electron';
import { type ToolbarAccount, TOOLBAR_HEIGHT } from '@magimail/core';
import {
  type ActionHandler,
  loadAddon,
  loadedAddon,
  setActionHandler,
  toolbarManager,
} from './native-addon.js';
import { toolbarLabels } from './toolbar-labels.js';
import { createLogger } from '@magimail/core/logger';

const log = createLogger('NativeToolbar');

export type { ToolbarAccount };

export function attachNativeToolbar(mainWindow: BaseWindow): void {
  const a = loadAddon();
  // Before attach, so the items AppKit builds carry their final labels. The
  // addon is a dylib, not a bundle, so it cannot read a String Catalog itself.
  toolbarManager.updateLabels(toolbarLabels());
  const handle = mainWindow.getNativeWindowHandle();
  a.attach(handle);
  mainWindow.setSheetOffset(TOOLBAR_HEIGHT);
}

export function detachNativeToolbar(): void {
  loadedAddon()?.detach();
}

export function updateNativeToolbarAccounts(
  accounts: ToolbarAccount[],
  activeAccountId: string,
): void {
  loadedAddon()?.updateAccounts(
    JSON.stringify({
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        color: a.color,
        unreadCount: a.unreadCount,
        excludedByFocus: Boolean(a.excludedByFocus),
        disabledByFocus: Boolean(a.disabledByFocus),
        needsAuth: Boolean(a.needsAuth),
      })),
      activeAccountId,
    }),
  );
}

export function onNativeToolbarAction(handler: ActionHandler): void {
  setActionHandler(handler);
}

export function runToolbarCustomization(): void {
  loadedAddon()?.runCustomization();
}

export function nativeDropFiles(window: BaseWindow, filePaths: string[]): void {
  const a = loadAddon();
  const handle = window.getNativeWindowHandle();
  a.dropFiles(handle, filePaths);
}

export function setNativeToolbarItemEnabled(itemId: string, enabled: boolean): void {
  try {
    const a = loadAddon();
    a.setItemEnabled?.(itemId, enabled);
  } catch (err) {
    log.warn('setItemEnabled unavailable:', err);
  }
}

/**
 * Hand the native share picker the link it should offer.
 *
 * The picker asks its delegate for items synchronously when clicked, so the URL
 * has to be pushed across ahead of time. Pass an empty string to clear it.
 */
export function setNativeToolbarShareUrl(url: string): void {
  try {
    const a = loadAddon();
    a.setShareUrl?.(url);
  } catch (err) {
    log.warn('setShareUrl unavailable:', err);
  }
}

/**
 * Opens the macOS share sheet on `items`.
 *
 * `onFinished` runs once the chosen service has read the items, or once the sheet closes
 * with nothing chosen, so a caller sharing a temporary file knows when it can remove it.
 * A picker that never opens calls it straight away, because nothing will read the file.
 */
export function showNativeSharingPicker(
  window: BaseWindow,
  items: string[],
  onFinished?: () => void,
): void {
  try {
    const a = loadAddon();
    if (typeof a.showSharingPicker !== 'function') {
      throw new Error('addon exports no showSharingPicker');
    }
    a.showSharingPicker(window.getNativeWindowHandle(), items, onFinished);
  } catch (err) {
    log.warn('showSharingPicker unavailable:', err);
    onFinished?.();
  }
}
