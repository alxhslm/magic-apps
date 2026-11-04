import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TasksPoller } from '../src/tasks-poller.js';
import {
  TasksSessionExpiredError,
  TasksNetworkError,
  TasksDecodeError,
  TasksRateLimitedError,
  TasksRefusedError,
} from '../src/tasks-decoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fixturePath = path.resolve(__dirname, 'fixtures/tasks-web-sync.json');
const fixtureContent = fs.readFileSync(fixturePath, 'utf8');

describe('tasks-poller', () => {
  it('returns empty tasks map if gaiaId is not provided', async () => {
    const poller = new TasksPoller({
      id: 'acc1:tasks',
      accountId: 'acc1',
      partition: 'persist:test',
    });

    const result = await poller.fetchTasks();
    expect(result.tasks.size).toBe(0);
  });

  it('throws TasksSessionExpiredError when SAPISID cookie is missing', async () => {
    const poller = new TasksPoller({
      id: 'acc1:tasks',
      accountId: 'acc1',
      partition: 'persist:test',
      gaiaId: '100000000000000000001',
      getSapisidImpl: async () => null,
    });

    await expect(poller.fetchTasks()).rejects.toThrow(TasksSessionExpiredError);
  });

  it('signs and fetches tasks successfully', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';

    const fetchImpl = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = init.body as string;
      return new Response(fixtureContent, { status: 200 });
    });

    const poller = new TasksPoller({
      id: 'acc1:tasks',
      accountId: 'acc1',
      partition: 'persist:test',
      gaiaId: '100000000000000000001',
      accountIndex: 0,
      apiKey: 'test_page_api_key',
      getSapisidImpl: async () => 'test_sapisid_cookie_value',
      fetchImpl,
    });

    const result = await poller.fetchTasks();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(capturedUrl).toContain('tasks-pa.clients6.google.com');
    expect(capturedHeaders['Authorization']).toMatch(/^SAPISIDHASH \d+_[0-9a-f]{40}_u$/);
    expect(capturedHeaders['X-Goog-Api-Key']).toBe('test_page_api_key');
    expect(capturedHeaders['X-Goog-AuthUser']).toBe('0');
    // Google answers 401 without it, however well formed the SAPISIDHASH is.
    expect(capturedHeaders['Origin']).toBe('https://calendar.google.com');
    expect(capturedBody).toContain('100000000000000000001');

    expect(result.tasks.size).toBe(2);
    expect(poller.lastSuccessfulReadAt).toBeInstanceOf(Date);
  });

  it('omits the API key header until the page has been read', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return new Response(fixtureContent, { status: 200 });
    });

    const poller = new TasksPoller({
      id: 'acc1:tasks',
      accountId: 'acc1',
      partition: 'persist:test',
      gaiaId: '100000000000000000001',
      getSapisidImpl: async () => 'test_sapisid',
      fetchImpl,
    });

    await poller.fetchTasks();

    expect(capturedHeaders['X-Goog-Api-Key']).toBeUndefined();
  });

  it('reports and adopts an API key learned after construction', () => {
    const poller = new TasksPoller({
      id: 'acc1:tasks',
      accountId: 'acc1',
      partition: 'persist:test',
    });

    expect(poller.currentApiKey).toBeUndefined();
    poller.updateApiKey('later_page_api_key');
    expect(poller.currentApiKey).toBe('later_page_api_key');
  });

  it('handles 401 response as TasksSessionExpiredError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Unauthorized', { status: 401 }));

    const poller = new TasksPoller({
      id: 'acc1:tasks',
      accountId: 'acc1',
      partition: 'persist:test',
      gaiaId: '100000000000000000001',
      getSapisidImpl: async () => 'test_sapisid',
      fetchImpl,
    });

    await expect(poller.fetchTasks()).rejects.toThrow(TasksSessionExpiredError);
  });

  it('handles network error as TasksNetworkError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Connection reset'));

    const poller = new TasksPoller({
      id: 'acc1:tasks',
      accountId: 'acc1',
      partition: 'persist:test',
      gaiaId: '100000000000000000001',
      getSapisidImpl: async () => 'test_sapisid',
      fetchImpl,
    });

    await expect(poller.fetchTasks()).rejects.toThrow(TasksNetworkError);
  });

  it('tells a refusal apart from a malformed response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));

    const poller = new TasksPoller({
      id: 'acc1:tasks',
      accountId: 'acc1',
      partition: 'persist:test',
      gaiaId: '100000000000000000001',
      getSapisidImpl: async () => 'test_sapisid',
      fetchImpl,
    });

    const failure = poller.fetchTasks();
    await expect(failure).rejects.toThrow(TasksRefusedError);
    await expect(failure).rejects.toMatchObject({ status: 403 });
  });

  it('does not ask Google again while a refusal is cooling down', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
      const fetchImpl = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));

      const poller = new TasksPoller({
        id: 'acc1:tasks',
        accountId: 'acc1',
        partition: 'persist:test',
        gaiaId: '100000000000000000001',
        getSapisidImpl: async () => 'test_sapisid',
        fetchImpl,
      });

      await expect(poller.fetchTasks()).rejects.toThrow(TasksRefusedError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // The next poll lands inside the pause: it reuses the refusal rather than asking.
      vi.advanceTimersByTime(5 * 60 * 1000);
      await expect(poller.fetchTasks()).rejects.toThrow(TasksRefusedError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Once the pause is over, Google is asked again and a refusal doubles the pause.
      vi.advanceTimersByTime(15 * 60 * 1000);
      await expect(poller.fetchTasks()).rejects.toThrow(TasksRefusedError);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the refusal after a read that succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }))
      .mockResolvedValue(new Response(fixtureContent, { status: 200 }));

    const poller = new TasksPoller({
      id: 'acc1:tasks',
      accountId: 'acc1',
      partition: 'persist:test',
      gaiaId: '100000000000000000001',
      getSapisidImpl: async () => 'test_sapisid',
      fetchImpl,
    });

    await expect(poller.fetchTasks()).rejects.toThrow(TasksRefusedError);
    // A successful read is the only thing that ends an episode, so reach past the pause.
    const refusedUntil = Date.now() + 15 * 60 * 1000 + 1;
    vi.spyOn(Date, 'now').mockReturnValue(refusedUntil);
    try {
      await expect(poller.fetchTasks()).resolves.toBeDefined();
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('pauses on a 429 rather than retrying on the next poll', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(new Response('Too many requests', { status: 429 }));

      const poller = new TasksPoller({
        id: 'acc1:tasks',
        accountId: 'acc1',
        partition: 'persist:test',
        gaiaId: '100000000000000000001',
        getSapisidImpl: async () => 'test_sapisid',
        fetchImpl,
      });

      await expect(poller.fetchTasks()).rejects.toThrow(TasksRateLimitedError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // Inside the pause Google is left alone, however often the poll asks.
      vi.advanceTimersByTime(30 * 1000);
      await expect(poller.fetchTasks()).rejects.toMatchObject({ retryAfterMs: 60 * 1000 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      // The pause doubles for a rate limit that keeps happening.
      vi.advanceTimersByTime(31 * 1000);
      await expect(poller.fetchTasks()).rejects.toMatchObject({ retryAfterMs: 120 * 1000 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honours a Retry-After the rate limit asks for', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response('Too many requests', {
          status: 429,
          headers: { 'retry-after': '120' },
        }),
      );

      const poller = new TasksPoller({
        id: 'acc1:tasks',
        accountId: 'acc1',
        partition: 'persist:test',
        gaiaId: '100000000000000000001',
        getSapisidImpl: async () => 'test_sapisid',
        fetchImpl,
      });

      await expect(poller.fetchTasks()).rejects.toMatchObject({ retryAfterMs: 120 * 1000 });

      vi.advanceTimersByTime(60 * 1000);
      await expect(poller.fetchTasks()).rejects.toThrow(TasksRateLimitedError);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the rate limit after a read that succeeds', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('Too many requests', { status: 429 }))
        .mockResolvedValue(new Response(fixtureContent, { status: 200 }));

      const poller = new TasksPoller({
        id: 'acc1:tasks',
        accountId: 'acc1',
        partition: 'persist:test',
        gaiaId: '100000000000000000001',
        getSapisidImpl: async () => 'test_sapisid',
        fetchImpl,
      });

      await expect(poller.fetchTasks()).rejects.toThrow(TasksRateLimitedError);
      vi.advanceTimersByTime(61 * 1000);
      await expect(poller.fetchTasks()).resolves.toBeDefined();

      // The episode is over, so the next rate limit starts from the base pause again.
      fetchImpl.mockResolvedValue(new Response('Too many requests', { status: 429 }));
      await expect(poller.fetchTasks()).rejects.toMatchObject({ retryAfterMs: 60 * 1000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('handles 500 response as TasksDecodeError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('Server error', { status: 500 }));

    const poller = new TasksPoller({
      id: 'acc1:tasks',
      accountId: 'acc1',
      partition: 'persist:test',
      gaiaId: '100000000000000000001',
      getSapisidImpl: async () => 'test_sapisid',
      fetchImpl,
    });

    await expect(poller.fetchTasks()).rejects.toThrow(TasksDecodeError);
  });
});
