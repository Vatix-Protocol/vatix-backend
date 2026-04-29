export interface RetryOptions {
  /** Maximum number of total attempts, including the first call. */
  maxAttempts?: number;
  /** Initial delay before the first retry attempt, in milliseconds. */
  initialDelayMs?: number;
  /** Maximum backoff delay between attempts, in milliseconds. */
  maxDelayMs?: number;
  /** Exponential backoff growth factor. */
  factor?: number;
  /** Enable full jitter to avoid retry storms under provider outage. */
  jitter?: boolean;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 200,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
};

export class RetryableError extends Error {
  public readonly retryable = true;
  public cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "RetryableError";
    this.cause = cause;
    Error.captureStackTrace(this, this.constructor);
  }

  static wrap(error: Error, message?: string): RetryableError {
    return new RetryableError(message ?? error.message, error);
  }
}

export class ProviderRetryError extends Error {
  public readonly attempts: number;
  public readonly originalError: unknown;

  constructor(message: string, attempts: number, originalError: unknown) {
    super(message);
    this.name = "ProviderRetryError";
    this.attempts = attempts;
    this.originalError = originalError;
    if (originalError instanceof Error && originalError.stack) {
      this.stack = originalError.stack;
    }
    Error.captureStackTrace(this, this.constructor);
  }
}

export function isRetryableError(error: unknown): error is RetryableError {
  return (
    error instanceof RetryableError ||
    (typeof error === "object" &&
      error !== null &&
      "retryable" in error &&
      (error as { retryable?: unknown }).retryable === true)
  );
}

function getErrorDescription(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function calculateDelay(
  attempt: number,
  options: Required<RetryOptions>
): number {
  const backoff = Math.min(
    options.initialDelayMs * Math.pow(options.factor, attempt - 1),
    options.maxDelayMs
  );

  if (!options.jitter) {
    return Math.max(1, Math.round(backoff));
  }

  return Math.max(1, Math.round(Math.random() * backoff));
}

/**
 * Retry an async provider operation when a retryable error occurs.
 *
 * Retries only when the thrown error is retryable and stops after the
 * configured maximum number of attempts. Final failure includes context
 * about the attempted number of retries and the original error.
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const config = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const shouldRetry = isRetryableError(error);
      const isLastAttempt = attempt === config.maxAttempts;

      if (!shouldRetry || isLastAttempt) {
        break;
      }

      const delay = calculateDelay(attempt, config);
      await sleep(delay);
    }
  }

  throw new ProviderRetryError(
    `Provider operation failed after ${config.maxAttempts} attempts: ${getErrorDescription(lastError)}`,
    config.maxAttempts,
    lastError
  );
}
