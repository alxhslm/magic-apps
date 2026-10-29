/**
 * Watches the account view on screen for a page that has stopped presenting.
 *
 * A view that stops presenting keeps running: its DOM answers toolbar actions,
 * and nothing reaches the screen. The page's own capture is the cheapest way to
 * tell that from a dead window, and it is the signal the report of 27 October
 * was built on. Two uniform frames in a row are taken as one, so a slow first
 * paint is not mistaken for it.
 *
 * The repair is a new window rather than a new view. Rebuilding the view is what
 * the twenty attempts in the log of 29 October did, each attaching and navigating
 * a fresh WebContents, with the window still blank until it was closed.
 */

/** The part of `NativeImage` this needs, so a test can hand in a buffer. */
export interface CapturedFrame {
  isEmpty: () => boolean;
  getSize: () => { width: number; height: number };
  toBitmap: () => Buffer;
}

/** The part of `WebContents` this needs. */
export interface PresentingWebContents {
  isDestroyed: () => boolean;
  isLoading: () => boolean;
  capturePage: () => Promise<CapturedFrame>;
}

export interface PresentingView {
  webContents: PresentingWebContents;
}

export interface PresentingVerdict {
  uniform: boolean;
  /** The single colour a uniform frame is made of, as `#rrggbbaa`. */
  color?: string;
  size: { width: number; height: number };
}

/**
 * Whether a captured frame is one flat colour.
 *
 * A page that has painted a calendar has text, grid lines and event blocks in it,
 * whatever the theme, so a flat frame means the compositor produced nothing.
 */
export function analyseFrame(image: CapturedFrame): PresentingVerdict {
  const size = image.getSize();
  if (image.isEmpty() || size.width === 0 || size.height === 0) {
    return { uniform: true, color: '#00000000', size };
  }

  const buffer = image.toBitmap();
  if (buffer.length < 4) {
    return { uniform: true, color: '#00000000', size };
  }

  const pixels = new Uint32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
  const first = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    if (pixels[i] !== first) return { uniform: false, size };
  }

  const color =
    '#' +
    [buffer[0], buffer[1], buffer[2], buffer[3]]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  return { uniform: true, color, size };
}

export interface PresentingWatchdogOptions {
  /** The view the user is looking at, or undefined while there is none. */
  activeView: () => PresentingView | undefined;

  /**
   * Whether the window is on screen and in front.
   *
   * A hidden window, and a window covered by another app, are both left unpainted
   * by the compositor without being broken, so neither may be judged.
   */
  isWindowVisible: () => boolean;

  /** Runs when the view has stopped presenting. */
  rebuildWindow: (reason: string) => void;

  log: { info: (message: string) => void; warn: (message: string) => void };

  now?: () => number;

  /** How often to look. */
  intervalMs?: number;

  /** How long to leave a rebuilt window alone before judging it again. */
  quietMs?: number;

  /** Uniform frames in a row before acting. */
  uniformFramesBeforeRebuild?: number;
}

export type PresentingCheck = 'skipped' | 'rendered' | 'uniform';

export const PRESENTING_INTERVAL_MS = 10_000;
export const PRESENTING_QUIET_MS = 120_000;
export const PRESENTING_UNIFORM_FRAMES = 2;

export class PresentingWatchdog {
  private timer?: ReturnType<typeof setInterval>;
  private uniformFrames = 0;
  private verdict?: 'rendered' | 'uniform';
  private quietUntil = 0;

  constructor(private readonly options: PresentingWatchdogOptions) {}

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), this.interval());
    // Never hold the event loop open just to take a screenshot.
    this.timer.unref?.();
  }

  public stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Looks at the view once.
   *
   * Public so the window's own show and focus can ask immediately, and so a test
   * can drive it without a clock.
   */
  public async check(): Promise<PresentingCheck> {
    if (!this.options.isWindowVisible()) return 'skipped';
    if (this.now() < this.quietUntil) return 'skipped';

    const view = this.options.activeView();
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed() || contents.isLoading()) return 'skipped';

    let frame: CapturedFrame;
    try {
      frame = await contents.capturePage();
    } catch (error) {
      this.options.log.warn(`Could not capture the account view to check it: ${String(error)}`);
      return 'skipped';
    }

    // The view may have been switched or rebuilt while the capture was in flight.
    if (this.options.activeView()?.webContents !== contents) return 'skipped';

    const verdict = analyseFrame(frame);
    if (!verdict.uniform) {
      this.uniformFrames = 0;
      // Only a recovery is worth a line; the first painted frame of a fresh window
      // is not news, and one per launch would train the reader to skip the message.
      if (this.verdict === 'uniform') {
        this.options.log.info('The account view is presenting again');
      }
      this.verdict = 'rendered';
      return 'rendered';
    }

    this.uniformFrames += 1;
    if (
      this.uniformFrames < (this.options.uniformFramesBeforeRebuild ?? PRESENTING_UNIFORM_FRAMES)
    ) {
      return 'uniform';
    }

    this.uniformFrames = 0;
    this.verdict = 'uniform';
    this.quietUntil = this.now() + this.quiet();
    this.options.log.warn(
      `The account view has not presented: ${verdict.size.width}x${verdict.size.height} of ` +
        `${verdict.color}. Rebuilding the window`,
    );
    this.options.rebuildWindow('account view stopped presenting');
    return 'uniform';
  }

  private interval(): number {
    return this.options.intervalMs ?? PRESENTING_INTERVAL_MS;
  }

  private quiet(): number {
    return this.options.quietMs ?? PRESENTING_QUIET_MS;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
