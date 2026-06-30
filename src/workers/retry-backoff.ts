export interface RetryBackoffConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitter: boolean;
}

export const DEFAULT_RETRY_BACKOFF: RetryBackoffConfig = {
  initialDelayMs: 500,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: true,
};

export function computeBackoffDelay(
  attempt: number,
  config: RetryBackoffConfig = DEFAULT_RETRY_BACKOFF
): number {
  const base = Math.min(
    config.initialDelayMs * Math.pow(config.multiplier, attempt),
    config.maxDelayMs
  );
  return config.jitter ? base * (0.5 + Math.random() * 0.5) : base;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  config: RetryBackoffConfig = DEFAULT_RETRY_BACKOFF
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        const delay = computeBackoffDelay(attempt, config);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}
