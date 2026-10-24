import * as path from 'node:path';
import { NativeToolbarManager, type NativeToolbarAddon, type ActionHandler } from '@magimail/core';
import { createLogger } from '@magimail/core/logger';

export type { ActionHandler };

/**
 * The in-process native addon for Magimail.
 *
 * One N-API binary (`magimail_addon.node`) over one Swift dylib
 * (`libMagimailNative.dylib`), loaded into the Electron main process.
 */
export interface MagimailNativeAddon extends NativeToolbarAddon {
  setShareUrl(url: string): void;
  dropFiles(nativeWindowHandle: Buffer, filePaths: string[]): void;
  showSharingPicker(nativeWindowHandle: Buffer, items: string[], onFinished?: () => void): void;
  reloadWidgets(): void;
  /** App Group container path, creating the container. Null if not entitled. */
  groupContainerPath(groupId: string): string | null;
  /** The App Group this build is entitled for, from its signature. Null when unsigned. */
  appGroupIdentifier(): string | null;
  /** Base64 of the 32-byte local cache key, created on first use. Null when unsigned. */
  localCacheKey(): string | null;
}

export type NativeAddon = MagimailNativeAddon;

export const toolbarManager = new NativeToolbarManager<MagimailNativeAddon>({
  addonPaths: [
    path.resolve(__dirname, '../native/build/Release/magimail_addon.node'),
    path.resolve(__dirname, '../../native/build/Release/magimail_addon.node'),
    path.resolve(process.resourcesPath || '', 'magimail_addon.node'),
  ],
  dylibPaths: [
    path.resolve(__dirname, '../native/.build/debug/libMagimailNative.dylib'),
    path.resolve(__dirname, '../../native/.build/debug/libMagimailNative.dylib'),
    path.resolve(__dirname, '../native/.build/release/libMagimailNative.dylib'),
    path.resolve(__dirname, '../../native/.build/release/libMagimailNative.dylib'),
    path.resolve(process.resourcesPath || '', 'libMagimailNative.dylib'),
  ],
  logPrefix: '[MagimailToolbar]',
  logger: createLogger('NativeToolbar'),
});

export function loadAddon(): MagimailNativeAddon {
  return toolbarManager.loadAddon();
}

export function loadedAddon(): MagimailNativeAddon | null {
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
