/**
 * Bounded retry with exponential backoff for async operations.
 * Used by EventFetcher for transient RPC failures.
 */

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "socket hang up",
]);

/**
 * Returns true when the error looks like a transient network failure
 * that is safe to retry.
 */
export function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code ?? "";
  return TRANSIENT_CODES.has(code) || TRANSIENT_CODES.has(err.message);
}

/**
 * Sleep for `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  /** Maximum number of retry attempts after the first failure. */
  maxRetries: number;
  /** Base delay in ms; doubles on each attempt (exponential backoff). */
  retryDelayMs: number;
}

export class RetryValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "RetryValidationError";
  }
}

function validateRetryOptions(options: RetryOptions): void {
  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new RetryValidationError("maxRetries must be a non-negative integer");
  }
  if (!Number.isFinite(options.retryDelayMs) || options.retryDelayMs < 0) {
    throw new RetryValidationError(
      "retryDelayMs must be a non-negative number"
    );
  }
}

/**
 * Execute `fn` with bounded retries on transient errors.
 *
 * @throws {RetryValidationError} When options are invalid (statusCode 400).
 * @throws The last error when retries are exhausted or the error is non-transient.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  validateRetryOptions(options);
  const { maxRetries, retryDelayMs } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxRetries;
      if (isLast || !isTransientError(err)) {
        throw err;
      }
      await sleep(retryDelayMs * 2 ** attempt);
    }
  }

  // Unreachable — satisfies TypeScript
  throw new Error("withRetry: exhausted retries");
}
