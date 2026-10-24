export interface RetrySchedulerOptions {
  /**
   * Maximum number of retry attempts before giving up until reset.
   * Defaults to 1.
   */
  maxRetries?: number;
  /**
   * Delay in milliseconds before executing the retry callback.
   * Defaults to 1000.
   */
  delayMs?: number;
}

/**
 * Manages bounded, cancellable retry execution.
 *
 * Used by menubar managers and other IPC callers when a pushed payload or RPC
 * fails to deliver and needs a deferred retry, without looping indefinitely or
 * firing obsolete updates after cancellation.
 */
export class RetryScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private readonly maxRetries: number;
  private readonly delayMs: number;

  constructor(options?: RetrySchedulerOptions) {
    this.maxRetries = options?.maxRetries ?? 1;
    this.delayMs = options?.delayMs ?? 1000;
  }

  /**
   * Schedules a retry if the number of attempts has not reached `maxRetries`.
   * Returns true if scheduled, false if maxRetries was already reached.
   */
  public schedule(fn: () => void): boolean {
    if (this.attempts >= this.maxRetries) {
      return false;
    }
    this.attempts++;
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, this.delayMs);
    return true;
  }

  /**
   * Cancels any pending scheduled retry timer without resetting the attempt count.
   */
  public cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Resets the attempt counter to zero.
   */
  public resetAttempts(): void {
    this.attempts = 0;
  }

  /**
   * Cancels any pending scheduled timer and resets the attempt counter.
   */
  public reset(): void {
    this.cancel();
    this.resetAttempts();
  }

  public get pending(): boolean {
    return this.timer !== null;
  }

  public get currentAttempts(): number {
    return this.attempts;
  }
}
