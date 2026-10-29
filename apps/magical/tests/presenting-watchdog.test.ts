import { describe, it, expect, vi } from 'vitest';
import {
  analyseFrame,
  PresentingWatchdog,
  type CapturedFrame,
  type PresentingWebContents,
} from '../src/presenting-watchdog.js';

function frame(pixels: number[], width = 2, height = 1): CapturedFrame {
  const buffer = Buffer.from(new Uint32Array(pixels).buffer);
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toBitmap: () => buffer,
  };
}

const UNIFORM = frame([0xffffffff, 0xffffffff]);
const VARIED = frame([0xffffffff, 0x00000000]);

function setup(options: {
  visible?: boolean;
  loading?: boolean;
  captures?: Array<CapturedFrame | Error>;
}) {
  const queued = [...(options.captures ?? [])];
  const contents = {
    isDestroyed: () => false,
    isLoading: () => options.loading ?? false,
    capturePage: vi.fn(async () => {
      const next = queued.shift();
      if (next instanceof Error) throw next;
      return next ?? VARIED;
    }),
  } as unknown as PresentingWebContents;

  let view: { webContents: PresentingWebContents } | undefined = { webContents: contents };
  const rebuildWindow = vi.fn();
  const log = { info: vi.fn(), warn: vi.fn() };
  let now = 0;

  const watchdog = new PresentingWatchdog({
    activeView: () => view,
    isWindowVisible: () => options.visible ?? true,
    rebuildWindow,
    log,
    now: () => now,
    quietMs: 1_000,
  });

  return {
    watchdog,
    contents,
    rebuildWindow,
    log,
    advance: (ms: number) => {
      now += ms;
    },
    setView: (next: typeof view) => {
      view = next;
    },
  };
}

describe('analysing a captured frame', () => {
  it('calls a single colour uniform and names it', () => {
    expect(analyseFrame(UNIFORM)).toEqual({
      uniform: true,
      color: '#ffffffff',
      size: { width: 2, height: 1 },
    });
  });

  it('calls a frame with two colours rendered', () => {
    expect(analyseFrame(VARIED).uniform).toBe(false);
  });

  it('treats an empty capture as not presenting', () => {
    const empty: CapturedFrame = {
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      toBitmap: () => Buffer.alloc(0),
    };
    expect(analyseFrame(empty).uniform).toBe(true);
  });
});

describe('watching the account view', () => {
  it('rebuilds the window after two uniform frames in a row', async () => {
    const harness = setup({ captures: [UNIFORM, UNIFORM] });

    expect(await harness.watchdog.check()).toBe('uniform');
    expect(harness.rebuildWindow).not.toHaveBeenCalled();

    expect(await harness.watchdog.check()).toBe('uniform');
    expect(harness.rebuildWindow).toHaveBeenCalledWith('account view stopped presenting');
  });

  it('starts over when a frame has painted', async () => {
    const harness = setup({ captures: [UNIFORM, VARIED, UNIFORM] });

    await harness.watchdog.check();
    await harness.watchdog.check();
    await harness.watchdog.check();

    expect(harness.rebuildWindow).not.toHaveBeenCalled();
  });

  it('leaves a hidden window alone', async () => {
    const harness = setup({ visible: false, captures: [UNIFORM, UNIFORM] });

    expect(await harness.watchdog.check()).toBe('skipped');
    expect(harness.contents.capturePage).not.toHaveBeenCalled();
  });

  it('leaves a page that is still loading alone', async () => {
    const harness = setup({ loading: true, captures: [UNIFORM, UNIFORM] });

    expect(await harness.watchdog.check()).toBe('skipped');
    expect(harness.contents.capturePage).not.toHaveBeenCalled();
  });

  it('stops judging a window it has just rebuilt', async () => {
    const harness = setup({ captures: [UNIFORM, UNIFORM, UNIFORM, UNIFORM] });

    await harness.watchdog.check();
    await harness.watchdog.check();
    expect(harness.rebuildWindow).toHaveBeenCalledTimes(1);

    expect(await harness.watchdog.check()).toBe('skipped');
    harness.advance(1_000);
    expect(await harness.watchdog.check()).toBe('uniform');
    expect(harness.rebuildWindow).toHaveBeenCalledTimes(1);
  });

  it('skips the check when the capture fails', async () => {
    const harness = setup({ captures: [new Error('no frame')] });

    expect(await harness.watchdog.check()).toBe('skipped');
    expect(harness.log.warn).toHaveBeenCalled();
    expect(harness.rebuildWindow).not.toHaveBeenCalled();
  });

  it('skips the check when the view was replaced mid-capture', async () => {
    const harness = setup({ captures: [UNIFORM, UNIFORM] });

    const first = harness.watchdog.check();
    harness.setView(undefined);
    await first;

    expect(harness.rebuildWindow).not.toHaveBeenCalled();
  });
});
