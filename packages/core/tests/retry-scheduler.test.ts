import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RetryScheduler } from '../src/retry-scheduler.js';

describe('RetryScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules callback after default delay of 1000ms', async () => {
    const scheduler = new RetryScheduler();
    const fn = vi.fn();

    const scheduled = scheduler.schedule(fn);
    expect(scheduled).toBe(true);
    expect(scheduler.pending).toBe(true);
    expect(scheduler.currentAttempts).toBe(1);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(scheduler.pending).toBe(false);
  });

  it('respects custom maxRetries and delayMs', async () => {
    const scheduler = new RetryScheduler({ maxRetries: 2, delayMs: 500 });
    const fn = vi.fn();

    expect(scheduler.schedule(fn)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(1);

    expect(scheduler.schedule(fn)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(2);

    // Exceeded maxRetries (2)
    expect(scheduler.schedule(fn)).toBe(false);
    expect(scheduler.pending).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('cancels pending timer', async () => {
    const scheduler = new RetryScheduler();
    const fn = vi.fn();

    scheduler.schedule(fn);
    expect(scheduler.pending).toBe(true);

    scheduler.cancel();
    expect(scheduler.pending).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).not.toHaveBeenCalled();
    // Attempts are still tracked unless reset
    expect(scheduler.currentAttempts).toBe(1);
  });

  it('resets attempts and cancels pending timer on reset()', async () => {
    const scheduler = new RetryScheduler({ maxRetries: 1 });
    const fn = vi.fn();

    scheduler.schedule(fn);
    scheduler.reset();

    expect(scheduler.pending).toBe(false);
    expect(scheduler.currentAttempts).toBe(0);

    // Can schedule again because attempts was reset
    expect(scheduler.schedule(fn)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('resets attempts on resetAttempts() while leaving timer intact', async () => {
    const scheduler = new RetryScheduler({ maxRetries: 1 });
    const fn = vi.fn();

    scheduler.schedule(fn);
    scheduler.resetAttempts();
    expect(scheduler.currentAttempts).toBe(0);
    expect(scheduler.pending).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
