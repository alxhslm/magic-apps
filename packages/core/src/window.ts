import type {
  BaseWindow,
  BaseWindowConstructorOptions,
  Rectangle,
  WebContentsView,
} from 'electron';

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
  /**
   * Where to put the window, overriding `width` and `height`.
   *
   * A window rebuilt in place returns to where the user had it, so recovering from a
   * blank window does not also move and resize it.
   */
  bounds?: Rectangle;
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
  const bounds = options.bounds;
  delete options.bounds;

  return {
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    ...options,
    ...bounds,
  };
}

export interface WindowRebuildOptions<Manager> {
  /** The window to replace, or null while the app has none. */
  window: () => BaseWindow | null;

  /** The manager that owns the account views, or null while the app has none. */
  manager: () => Manager | null;

  /** The account the replacement opens on. */
  accountId: (manager: Manager) => string;

  /** True once the app is quitting: a window being torn down is not rebuilt. */
  quitting: () => boolean;

  /** Builds the replacement at the bounds the old window had. */
  build: (accountId: string, bounds: Rectangle) => void;

  log: { info: (message: string) => void };
}

/**
 * Replaces the main window with a fresh one on the same account and bounds.
 *
 * The only recovery observed for a window that has stopped presenting, and it costs a
 * page load and a blink of the window. Both apps do it, so it lives here rather than
 * twice: the guard, the order of `closed` then rebuild, and the recursion flag are the
 * parts that have to be identical, and they are the parts a second copy gets wrong.
 */
export class WindowRebuilder<Manager> {
  private rebuilding = false;

  constructor(private readonly options: WindowRebuildOptions<Manager>) {}

  /**
   * Whether a replacement is being built.
   *
   * A `close` handler that would otherwise intercept the close — Magimail's tray turns
   * it into a hide — has to let it through, or the old window never goes and the
   * replacement is never built.
   */
  public isRebuilding(): boolean {
    return this.rebuilding;
  }

  /** Returns false when there is nothing to rebuild, or a rebuild is already running. */
  public rebuild(reason: string, detail?: string): boolean {
    const window = this.options.window();
    const manager = this.options.manager();
    if (!window || !manager || this.rebuilding || this.options.quitting()) return false;

    const accountId = this.options.accountId(manager);
    const bounds = window.getBounds();
    this.rebuilding = true;
    this.options.log.info(`Rebuilding the window: ${reason}${detail ? ` (${detail})` : ''}`);

    // The window's own `closed` handler clears the app's handles, and listeners run in
    // the order they were added, so this one rebuilds after the old window has gone.
    window.once('closed', () => {
      this.rebuilding = false;
      if (this.options.quitting()) return;
      this.options.build(accountId, bounds);
    });
    window.close();
    return true;
  }
}
