/**
 * Retry Utilities
 *
 * Provides bounded retries with exponential backoff for async operations.
 * Classifies errors to avoid retrying non-transient failures.
 *
 * @module apps/oracle/retry-utils
 */

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Initial delay before first retry in milliseconds */
  initialDelayMs: number;
  /** Maximum delay between retries in milliseconds */
  maxDelayMs: number;
  /** Exponential backoff factor (default: 2) */
  factor: number;
  /** Whether to add random jitter to delays (default: true) */
  useJitter?: boolean;
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 10_000,
  factor: 2,
  useJitter: true,
};

/**
 * Check if an error is considered retryable (transient).
 *
 * @param error - The error to classify
 * @returns True if the error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true; // Assume unknown errors might be transient
  }

  const message = error.message.toLowerCase();

  // Network/Connection errors
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("fetch") ||
    message.includes("abort")
  ) {
    return true;
  }

  // HTTP status codes (if available in message or as property)
  // Assuming errors might contain status codes like "429" or "503"
  if (
    message.includes("429") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504")
  ) {
    return true;
  }

  return false;
}

/**
 * Wait for a specified duration.
 *
 * @param ms - Duration in milliseconds
 */
export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Execute an async operation with bounded retries and exponential backoff.
 *
 * @param operation - The async operation to execute
 * @param config - Retry configuration
 * @param onRetry - Optional callback triggered on each retry
 * @returns Result of the operation
 * @throws The last error encountered if all retries fail
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  onRetry?: (error: Error, attempt: number, delayMs: number) => void
): Promise<T> {
  const fullConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: any;

  for (let attempt = 0; attempt <= fullConfig.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (attempt >= fullConfig.maxRetries || !isRetryableError(error)) {
        throw error;
      }

      // Calculate delay: initialDelay * factor^attempt
      let delayMs =
        fullConfig.initialDelayMs * Math.pow(fullConfig.factor, attempt);

      // Cap at maxDelay
      delayMs = Math.min(delayMs, fullConfig.maxDelayMs);

      // Add jitter (randomly vary delay by +/- 20%)
      if (fullConfig.useJitter !== false) {
        const jitter = (Math.random() * 0.4 - 0.2) * delayMs;
        delayMs = Math.max(0, delayMs + jitter);
      }

      if (onRetry) {
        onRetry(
          error instanceof Error ? error : new Error(String(error)),
          attempt + 1,
          delayMs
        );
      }

      await wait(delayMs);
    }
  }

  throw lastError;
}
