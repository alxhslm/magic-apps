import * as path from 'node:path';
import { NativeToolbarManager, type NativeToolbarAddon, type ActionHandler } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';

export type { ActionHandler };

export interface MagicalNativeAddon extends NativeToolbarAddon {
  updateDockDate?: (day: number, month: string, dayOfWeek?: string) => void;
  updateDockSvg?: (svgXml: string) => void;
  setDockBadge?: (badge: string | null) => void;
  updateInvites?: (json: string) => void;
  hasApplicationForUrl?: (url: string) => boolean;
  reloadWidgets?: () => void;
  /** App Group container path, creating the container. Null if not entitled. */
  groupContainerPath?: (groupId: string) => string | null;
  /** The App Group this build is entitled for, from its signature. Null when unsigned. */
  appGroupIdentifier?: () => string | null;
  /** Base64 of the 32-byte local cache key, created on first use. Null when unsigned. */
  localCacheKey?: () => string | null;
  sidebarAttach?: (handle: Buffer) => void;
  sidebarSetVisible?: (visible: boolean, animated: boolean) => void;
  sidebarUpdateData?: (json: string) => void;
  sidebarSetViewMode?: (mode: string, anchorDate?: string) => void;
}

export type NativeAddon = MagicalNativeAddon;

export const toolbarManager = new NativeToolbarManager<MagicalNativeAddon>({
  addonPaths: [
    path.resolve(__dirname, '../native/build/Release/magical_addon.node'),
    path.resolve(__dirname, '../../native/build/Release/magical_addon.node'),
    path.resolve(process.resourcesPath || '', 'magical_addon.node'),
  ],
  dylibPaths: [
    path.resolve(__dirname, '../native/.build/debug/libMagicalNative.dylib'),
    path.resolve(__dirname, '../../native/.build/debug/libMagicalNative.dylib'),
    path.resolve(__dirname, '../native/.build/release/libMagicalNative.dylib'),
    path.resolve(__dirname, '../../native/.build/release/libMagicalNative.dylib'),
    path.resolve(process.resourcesPath || '', 'libMagicalNative.dylib'),
  ],
  logPrefix: '[MagicalToolbar]',
  logger: createLogger('NativeToolbar'),
});

export function loadAddon(): MagicalNativeAddon {
  return toolbarManager.loadAddon();
}

export function loadedAddon(): MagicalNativeAddon | null {
  return toolbarManager.loadedAddon();
}

export function setActionHandler(handler: ActionHandler): void {
  toolbarManager.setActionHandler(handler);
}

/**
 * The 32-byte key the local cache files are encrypted under, from the keychain.
 *
 * Null when the keychain will not answer. Callers fail closed on null rather
 * than writing the files in the clear.
 */
export function localCacheKey(): Buffer | null {
  try {
    const base64 = loadAddon().localCacheKey?.();
    return base64 ? Buffer.from(base64, 'base64') : null;
  } catch {
    return null;
  }
}
