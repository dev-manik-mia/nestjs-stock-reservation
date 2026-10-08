import { isTransientDatabaseError } from './transient-error';

export interface RetryOptions {
  /** Total attempts including the first one. Must be >= 1. */
  maxAttempts: number;
  /** Upper bound of the first backoff window, doubled on every attempt. */
  baseDelayMs?: number;
  /** Decides whether a failure is worth another attempt. */
  shouldRetry?: (error: unknown) => boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation`, retrying on transient database errors with exponential
 * backoff and full jitter so that competing transactions don't collide again
 * in lock-step.
 */
export async function retryOnTransientError<T>(
  operation: () => Promise<T>,
  {
    maxAttempts,
    baseDelayMs = 25,
    shouldRetry = isTransientDatabaseError,
    sleep = defaultSleep,
  }: RetryOptions,
): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError('maxAttempts must be a positive integer');
  }

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) {
        throw error;
      }

      const backoffWindow = baseDelayMs * 2 ** (attempt - 1);
      await sleep(Math.random() * backoffWindow);
    }
  }
}
