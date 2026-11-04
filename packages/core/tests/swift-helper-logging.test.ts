import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const { spawnMock, existsSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  default: { existsSync: existsSyncMock },
}));

const { SwiftHelper } = await import('../src/swift-helper.js');

/**
 * The helper's diagnostics used to go to stdout, which is the JSON-RPC pipe --
 * so they were parsed as malformed JSON and dropped. These cover the route that
 * replaced it: stderr, with the level recoverable from the line.
 */

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: EventEmitter & { writable: boolean; write: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
}

let child: FakeChild;
let sink: {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function makeHelper(logPrefix?: string) {
  return new SwiftHelper({ candidatePaths: ['/fake/MagimailHelper'], logPrefix, logger: sink });
}

function makeTimedHelper(requestTimeoutMs = 1000) {
  return new SwiftHelper({
    candidatePaths: ['/fake/MagimailHelper'],
    logger: sink,
    requestTimeoutMs,
  });
}

function makeChild(): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: Object.assign(new EventEmitter(), { writable: true, write: vi.fn() }),
    kill: vi.fn(),
  }) as FakeChild;
}

/** Feeds a line to stderr and waits for readline to deliver it. */
async function emitStderr(line: string): Promise<void> {
  child.stderr.write(`${line}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/** Feeds a response to stdout and lets readline deliver it without running the request timer. */
async function emitStdout(line: string): Promise<void> {
  child.stdout.write(`${line}\n`);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  existsSyncMock.mockReturnValue(true);
  child = makeChild();
  spawnMock.mockReturnValue(child);
  sink = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('helper stderr routing', () => {
  it('maps an E line onto error', async () => {
    makeHelper().spawn();
    await emitStderr('E|Notifications|Failed to dispatch: boom');
    expect(sink.error).toHaveBeenCalledWith('(Notifications) Failed to dispatch: boom');
  });

  it('maps a W line onto warn', async () => {
    makeHelper().spawn();
    await emitStderr('W|Notifications|Permission denied');
    expect(sink.warn).toHaveBeenCalledWith('(Notifications) Permission denied');
  });

  it('maps an I line onto info', async () => {
    makeHelper().spawn();
    sink.info.mockClear();
    await emitStderr('I|Settings|Window shown');
    expect(sink.info).toHaveBeenCalledWith('(Settings) Window shown');
  });

  it('keeps an unstructured line rather than dropping it', async () => {
    // Swift runtime warnings and crash traces arrive with no prefix at all.
    makeHelper().spawn();
    sink.info.mockClear();
    await emitStderr('Fatal error: unexpectedly found nil');
    expect(sink.info).toHaveBeenCalledWith('Fatal error: unexpectedly found nil');
  });

  it('applies the prefix when one is configured', async () => {
    makeHelper('[MagicalHelper]').spawn();
    await emitStderr('W|Tray|Icon missing');
    expect(sink.warn).toHaveBeenCalledWith('[MagicalHelper] (Tray) Icon missing');
  });

  it('omits the category when the helper sends none', async () => {
    makeHelper().spawn();
    await emitStderr('E||Something broke');
    expect(sink.error).toHaveBeenCalledWith('Something broke');
  });
});

describe('helper exit codes', () => {
  it('logs a non-zero exit as an error, with the code', async () => {
    makeHelper().spawn();
    child.emit('exit', 3, null);
    expect(sink.error).toHaveBeenCalledWith('Exited abnormally (code 3)');
  });

  it('logs a clean exit as info', async () => {
    makeHelper().spawn();
    sink.info.mockClear();
    child.emit('exit', 0, null);
    expect(sink.info).toHaveBeenCalledWith('Exited (code 0)');
    expect(sink.error).not.toHaveBeenCalled();
  });

  it('treats our own SIGTERM as a clean shutdown, not a crash', async () => {
    // `kill()` on quit is the normal path and must not fill the log with errors.
    makeHelper().spawn();
    sink.info.mockClear();
    child.emit('exit', null, 'SIGTERM');
    expect(sink.info).toHaveBeenCalledWith('Exited (signal SIGTERM)');
    expect(sink.error).not.toHaveBeenCalled();
  });

  it('logs a crash signal as an error', async () => {
    makeHelper().spawn();
    child.emit('exit', null, 'SIGSEGV');
    expect(sink.error).toHaveBeenCalledWith('Exited abnormally (signal SIGSEGV)');
  });

  it('warns rather than staying silent when the binary is missing', () => {
    existsSyncMock.mockReturnValue(false);
    expect(makeHelper().spawn()).toBe(false);
    expect(sink.warn).toHaveBeenCalledWith('Binary not found: its native UI is absent this run');
  });

  it('forwards -AppleLanguages and -AppleLocale from process.argv to the helper', () => {
    const originalArgv = process.argv;
    try {
      process.argv = [
        'node',
        'main.js',
        '-AppleLanguages',
        '(en-US)',
        '-AppleLocale',
        'en_US',
        '--other',
        'value',
      ];
      makeHelper().spawn();
      expect(spawnMock).toHaveBeenCalledWith(
        '/fake/MagimailHelper',
        ['-AppleLanguages', '(en-US)', '-AppleLocale', 'en_US'],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } finally {
      process.argv = originalArgv;
    }
  });
});

describe('helper request timeout and recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves null on the first missed deadline but leaves the helper running', async () => {
    const helper = makeTimedHelper();
    helper.spawn();

    const promise = helper.send('tray.update', { test: true });
    expect(child.stdin.write).toHaveBeenCalledWith(
      `${JSON.stringify({ id: 1, method: 'tray.update', params: { test: true } })}\n`,
    );

    vi.advanceTimersByTime(1000);
    const result = await promise;

    expect(result).toBeNull();
    expect(sink.error).toHaveBeenCalledWith('tray.update timed out after 1000ms');
    expect(child.kill).not.toHaveBeenCalled();
    expect(helper.isRunning()).toBe(true);
  });

  it('kills on the second consecutive miss and resolves every in-flight request null', async () => {
    const helper = makeTimedHelper();
    helper.spawn();

    const p1 = helper.send('tray.update');
    vi.advanceTimersByTime(1000);
    expect(await p1).toBeNull();
    expect(child.kill).not.toHaveBeenCalled();

    const p2 = helper.send('tray.update');
    const p3 = helper.send('calendars.update');
    vi.advanceTimersByTime(1000);

    const [r2, r3] = await Promise.all([p2, p3]);
    expect(r2).toBeNull();
    expect(r3).toBeNull();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(helper.isRunning()).toBe(false);
  });

  it('resets the count when the helper replies, including to an earlier request', async () => {
    const helper = makeTimedHelper();
    helper.spawn();

    const p1 = helper.send('tray.update');
    vi.advanceTimersByTime(1000);
    await p1;

    // A reply that arrives after its own deadline still proves the helper is alive.
    await emitStdout(JSON.stringify({ id: 1, result: 'late' }));

    const p2 = helper.send('tray.update');
    vi.advanceTimersByTime(1000);
    expect(await p2).toBeNull();
    expect(child.kill).not.toHaveBeenCalled();

    const p3 = helper.send('tray.update');
    vi.advanceTimersByTime(1000);
    expect(await p3).toBeNull();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('respawns the helper on the send after the second miss terminates it', async () => {
    const helper = makeTimedHelper();
    helper.spawn();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const p1 = helper.send('tray.update');
    vi.advanceTimersByTime(1000);
    await p1;

    const p2 = helper.send('tray.update');
    vi.advanceTimersByTime(1000);
    await p2;

    expect(helper.isRunning()).toBe(false);

    const secondChild = makeChild();
    spawnMock.mockReturnValue(secondChild);

    helper.send('tray.update');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(secondChild.stdin.write).toHaveBeenCalled();
  });
});

describe('helper stdin failures', () => {
  it('logs a stream error instead of letting write EPIPE escape', async () => {
    const helper = makeHelper();
    helper.spawn();

    const promise = helper.send('tray.update');
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(sink.error).toHaveBeenCalledWith('Helper stdin failed: write EPIPE');
    await expect(promise).resolves.toBeNull();
    expect(helper.isRunning()).toBe(false);
  });

  it('logs a synchronous write failure and resolves that request null', async () => {
    const helper = makeHelper();
    helper.spawn();
    child.stdin.write.mockImplementationOnce(() => {
      throw new Error('write EPIPE');
    });

    await expect(helper.send('tray.update')).resolves.toBeNull();
    expect(sink.error).toHaveBeenCalledWith('tray.update write failed: write EPIPE');
  });

  it('logs the EPIPE when the helper is killed with a request still in flight', async () => {
    const helper = makeHelper();
    helper.spawn();

    const promise = helper.send('tray.update');
    helper.kill();
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect(sink.error).toHaveBeenCalledWith('Helper stdin failed: write EPIPE');
    await expect(promise).resolves.toBeNull();
  });
});
