import type { BaseWindowConstructorOptions, WebContentsView } from 'electron';

/**
 * Whether a view is still usable: present, with a WebContents that has not been destroyed.
 *
 * Electron's types say `view.webContents` is always there, and it is not: once the
 * WebContents is destroyed the property reads back undefined, so the natural guard
 * `!view.webContents.isDestroyed()` throws instead of answering — from a poll, where it
 * throws on every tick. Every caller is really asking whether the view is still there,
 * so they ask this, which also narrows the view for the code that follows.
 */
export function viewIsAlive(view: WebContentsView | null | undefined): view is WebContentsView {
  const contents = view?.webContents;
  if (!contents) return false;
  return !contents.isDestroyed();
}

export interface MainWindowConfigOptions extends Partial<BaseWindowConstructorOptions> {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  title: string;
  preloadPath?: string;
  partitionName?: string;
}

/**
 * Generates BaseWindow options for the main window shell.
 * BaseWindow creates a pure native window with no hidden renderer process,
 * saving ~100MB compared to BrowserWindow (which spawns an unused default page).
 * Account webviews are hosted as WebContentsView children instead.
 */
export function createMainWindowOptions(
  config: MainWindowConfigOptions,
): BaseWindowConstructorOptions {
  const options: MainWindowConfigOptions = { ...config };
  delete options.preloadPath;
  delete options.partitionName;

  return {
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    ...options,
  };
}
