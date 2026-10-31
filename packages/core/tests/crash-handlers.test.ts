import { describe, it, expect, vi, beforeEach } from 'vitest';

const { handlers, logInfo, logError, displayHandlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  displayHandlers: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock('electron', () => ({
  app: {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    },
    // Resolves straight away: the real `screen` cannot be read before the app is
    // ready, so the module defers its listeners to this promise.
    whenReady: () => Promise.resolve(),
  },
  screen: {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      displayHandlers.set(event, handler);
    },
  },
}));

vi.mock('../src/logger.js', () => ({
  createLogger: () => ({ info: logInfo, warn: vi.fn(), error: logError }),
}));

const { installCrashHandlers } = await import('../src/crash-handlers.js');

/**
 * These are the events behind "it stopped working": a pane goes blank, or the
 * window renders wrong, and nothing else in the app records why.
 */

function fire(event: string, ...args: unknown[]) {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`no handler registered for ${event}`);
  handler(...args);
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  installCrashHandlers();
});

describe('renderer crashes', () => {
  it('records the reason and exit code at error level', () => {
    fire('render-process-gone', {}, {}, { reason: 'crashed', exitCode: 133 });
    expect(logError).toHaveBeenCalledWith('Renderer gone: reason=crashed exitCode=133');
  });

  it('distinguishes an out-of-memory kill, which is a different bug', () => {
    fire('render-process-gone', {}, {}, { reason: 'oom', exitCode: 0 });
    expect(logError).toHaveBeenCalledWith('Renderer gone: reason=oom exitCode=0');
  });

  it('does not cry crash over an ordinary teardown', () => {
    // Every window close would otherwise land an error in the log.
    fire('render-process-gone', {}, {}, { reason: 'clean-exit', exitCode: 0 });
    expect(logError).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith('Renderer gone: reason=clean-exit exitCode=0');
  });
});

describe('child process crashes', () => {
  it('names the process that died', () => {
    fire('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 5 });
    expect(logError).toHaveBeenCalledWith('Child process gone: GPU reason=crashed exitCode=5');
  });

  it('prefers the specific name over the generic type', () => {
    fire(
      'child-process-gone',
      {},
      {
        type: 'Utility',
        name: 'Network Service',
        reason: 'launch-failed',
        exitCode: 1,
      },
    );
    expect(logError).toHaveBeenCalledWith(
      'Child process gone: Network Service reason=launch-failed exitCode=1',
    );
  });

  it('does not cry crash over an ordinary teardown', () => {
    fire('child-process-gone', {}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 });
    expect(logError).not.toHaveBeenCalled();
  });
});

describe('what is deliberately not captured', () => {
  it('leaves renderer console messages alone', () => {
    // Gmail logs continuously; capturing it would bury everything above.
    expect(handlers.has('console-message')).toBe(false);
  });
});

describe('display changes', () => {
  /**
   * Registered on ready rather than at install time, because `screen` throws before
   * the app is ready and this module loads before then in both apps.
   */
  it('records a display that came, went or changed metrics', async () => {
    await Promise.resolve();

    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
      const handler = displayHandlers.get(event);
      if (!handler) throw new Error(`no display handler registered for ${event}`);
      handler();
    }

    expect(logInfo).toHaveBeenCalledWith('Display added');
    expect(logInfo).toHaveBeenCalledWith('Display removed');
    expect(logInfo).toHaveBeenCalledWith('Display metrics changed');
  });
});
