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

export interface FrameAnalysis {
  uniform: boolean;
  color?: string;
  size: { width: number; height: number };
}

/**
 * Analyses a captured frame to determine whether it is a single uniform colour.
 *
 * A WebContentsView that stops presenting renders nothing, producing either
 * transparent pixels (#00000000) or an empty uniform surface. When a page has
 * finished loading, a real calendar layout always contains multiple colours
 * (grid lines, text, event blocks, toolbar).
 */
export function analyzeFrame(image: {
  isEmpty: () => boolean;
  getSize: () => { width: number; height: number };
  toBitmap: () => Buffer;
}): FrameAnalysis {
  const size = image.getSize();
  if (image.isEmpty() || size.width === 0 || size.height === 0) {
    return { uniform: true, color: '#00000000', size };
  }
  const buffer = image.toBitmap();
  if (buffer.length < 4) {
    return { uniform: true, color: '#00000000', size };
  }

  const u32 = new Uint32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
  const first = u32[0];
  for (let i = 1; i < u32.length; i++) {
    if (u32[i] !== first) {
      return { uniform: false, size };
    }
  }

  const b0 = buffer[0];
  const b1 = buffer[1];
  const b2 = buffer[2];
  const b3 = buffer[3];
  const color = '#' + [b0, b1, b2, b3].map((b) => b.toString(16).padStart(2, '0')).join('');
  return { uniform: true, color, size };
}
