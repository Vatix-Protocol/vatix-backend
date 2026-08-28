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

import {
  ProviderRetryError,
  RetryableError,
  retryWithBackoff,
} from "../../src/services/providerRetry.js";

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
    return true;
  }

  const message = error.message.toLowerCase();

  // Non-retryable: 4xx client errors
  if (
    message.includes("400") ||
    message.includes("401") ||
    message.includes("403") ||
    message.includes("404") ||
    message.includes("bad request") ||
    message.includes("invalid")
  ) {
    return false;
  }

  return true;
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

  try {
    return await retryWithBackoff(
      async () => {
        try {
          return await operation();
        } catch (error) {
          if (!isRetryableError(error)) {
            throw error;
          }
          throw RetryableError.wrap(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      },
      {
        maxAttempts: fullConfig.maxRetries + 1,
        initialDelayMs: fullConfig.initialDelayMs,
        maxDelayMs: fullConfig.maxDelayMs,
        factor: fullConfig.factor,
        jitter: fullConfig.useJitter !== false,
        onRetry: onRetry
          ? (error, attempt, delayMs) =>
              onRetry(error.cause ?? error, attempt, delayMs)
          : undefined,
      }
    );
  } catch (error) {
    if (error instanceof ProviderRetryError) {
      const originalError = error.originalError;
      if (originalError instanceof RetryableError) {
        throw originalError.cause ?? originalError;
      }
      throw originalError;
    }
    throw error;
  }
}
