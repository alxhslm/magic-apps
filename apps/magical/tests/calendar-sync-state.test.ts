import { describe, it, expect, vi, beforeEach } from 'vitest';
import { session } from 'electron';
import { observeSyncState, syncStateFor, setSyncStateForTest } from '../src/calendar-sync-state.js';

vi.mock('electron', () => {
  const listeners = new Map<string, any>();
  const mockSession = {
    webRequest: {
      onBeforeRequest: vi.fn((filter, listener) => {
        listeners.set('onBeforeRequest', listener);
      }),
      onCompleted: vi.fn((filter, listener) => {
        listeners.set('onCompleted', listener);
      }),
    },
  };
  return {
    session: {
      fromPartition: vi.fn(() => mockSession),
    },
    _listeners: listeners,
  };
});

describe('calendar-sync-state', () => {
  const partition = 'persist:test_partition';

  beforeEach(() => {
    vi.clearAllMocks();
    setSyncStateForTest(partition, undefined);
  });

  it('captures POST sync.sync state on beforeRequest', () => {
    const stop = observeSyncState(partition);
    const mockSes = session.fromPartition(partition);
    const listener = vi.mocked(mockSes.webRequest.onBeforeRequest).mock.calls[0]?.[1];
    expect(listener).toBeDefined();

    const envelope = [[null, 'token123', null, null, null], 20000];
    const encodedEnvelope = encodeURIComponent(JSON.stringify(envelope));
    const body = `f.req=${encodedEnvelope}&cwuik=10&hl=en-GB&secid=abc`;

    const callback = vi.fn();
    listener!(
      {
        url: 'https://calendar.google.com/calendar/u/0/sync.sync',
        method: 'POST',
        uploadData: [{ bytes: Buffer.from(body, 'utf8') }],
      } as any,
      callback,
    );

    expect(callback).toHaveBeenCalledWith({ cancel: false });
    const captured = syncStateFor(partition);
    expect(captured).toBeDefined();
    expect(captured?.url).toBe('https://calendar.google.com/calendar/u/0/sync.sync');
    expect(captured?.params).toBe('cwuik=10&hl=en-GB&secid=abc');

    stop();
  });

  it('notifies onMutation when a POST sync request completes successfully', () => {
    const onMutation = vi.fn();
    const stop = observeSyncState(partition, onMutation);
    const mockSes = session.fromPartition(partition);
    const onCompleted = vi.mocked(mockSes.webRequest.onCompleted).mock.calls[0]?.[1];
    expect(onCompleted).toBeDefined();

    onCompleted!({
      url: 'https://calendar.google.com/calendar/u/0/sync.sync',
      method: 'POST',
      statusCode: 200,
    } as any);

    expect(onMutation).toHaveBeenCalledTimes(1);

    // Non-200 or non-POST should not trigger
    onCompleted!({
      url: 'https://calendar.google.com/calendar/u/0/sync.sync',
      method: 'GET',
      statusCode: 200,
    } as any);
    expect(onMutation).toHaveBeenCalledTimes(1);

    onCompleted!({
      url: 'https://calendar.google.com/calendar/u/0/sync.sync',
      method: 'POST',
      statusCode: 500,
    } as any);
    expect(onMutation).toHaveBeenCalledTimes(1);

    stop();
    expect(mockSes.webRequest.onBeforeRequest).toHaveBeenCalledWith(expect.any(Object), null);
    expect(mockSes.webRequest.onCompleted).toHaveBeenCalledWith(expect.any(Object), null);
  });
});
