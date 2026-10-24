import { describe, it, expect, vi, beforeEach } from 'vitest';

const listeners = new Map<string, (event: { preventDefault: () => void }, arg: string) => void>();

vi.mock('electron', () => ({
  app: {
    on: vi.fn((name: string, handler: never) => listeners.set(name, handler)),
  },
}));

/**
 * A fresh copy of the module per test. Its queue and its handler are process-wide by
 * design — the app registers them once at launch — so tests that shared one would see
 * each other's files.
 */
async function freshHandler() {
  listeners.clear();
  vi.resetModules();
  const module = await import('../src/ics-handler.js');
  module.watchForIcsFiles();
  return {
    ...module,
    openFile: (filePath: string) =>
      listeners.get('open-file')?.({ preventDefault: () => {} }, filePath),
  };
}

describe('open-file queueing', () => {
  beforeEach(() => {
    listeners.clear();
  });

  it('replays a file that arrived before anything could handle it', async () => {
    const { openFile, onIcsFile } = await freshHandler();
    openFile('/tmp/invite.ics');

    const handler = vi.fn();
    onIcsFile(handler);

    expect(handler).toHaveBeenCalledWith('/tmp/invite.ics');
  });

  it('replays every queued file, in the order they arrived', async () => {
    const { openFile, onIcsFile } = await freshHandler();
    openFile('/tmp/first.ics');
    openFile('/tmp/second.ics');

    const handler = vi.fn();
    onIcsFile(handler);

    expect(handler.mock.calls.map(([p]) => p)).toEqual(['/tmp/first.ics', '/tmp/second.ics']);
  });

  it('drains the queue, so a later handler does not see the same file again', async () => {
    const { openFile, onIcsFile } = await freshHandler();
    openFile('/tmp/invite.ics');
    onIcsFile(vi.fn());

    const later = vi.fn();
    onIcsFile(later);

    expect(later).not.toHaveBeenCalled();
  });

  it('passes a file straight through once a handler is installed', async () => {
    const { openFile, onIcsFile } = await freshHandler();
    const handler = vi.fn();
    onIcsFile(handler);

    openFile('/tmp/later.ics');

    expect(handler).toHaveBeenCalledWith('/tmp/later.ics');
  });

  it('ignores a file that is not an .ics', async () => {
    const { openFile, onIcsFile } = await freshHandler();
    const handler = vi.fn();
    onIcsFile(handler);

    openFile('/tmp/notes.txt');

    expect(handler).not.toHaveBeenCalled();
  });

  it('accepts an .ics whose extension is upper case', async () => {
    const { openFile, onIcsFile } = await freshHandler();
    const handler = vi.fn();
    onIcsFile(handler);

    openFile('/tmp/INVITE.ICS');

    expect(handler).toHaveBeenCalledWith('/tmp/INVITE.ICS');
  });
});
