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
 *
 * Every field is validated by {@link normalizeRetryConfig} before any provider
 * call is made, so a malformed value fails closed instead of degrading into an
 * unbounded retry loop. See {@link MAX_RETRIES_LIMIT}.
 */
export interface RetryConfig {
  /** Maximum number of retry attempts (after the initial call) */
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
 * Hard ceiling on retries, independent of caller-supplied config.
 *
 * A retry budget is the only thing standing between a stuck provider and an
 * unbounded wait on the money path. Anything above this is treated as a
 * misconfiguration and rejected rather than honoured.
 */
export const MAX_RETRIES_LIMIT = 10;

/** Hard ceiling on any single backoff delay (10 minutes). */
export const MAX_DELAY_MS_LIMIT = 600_000;

/**
 * Thrown when a retry configuration would make retries unbounded or degenerate.
 *
 * `code` is stable so callers/metrics can key on it; the message names only the
 * offending field and never echoes caller data, so it is safe to log.
 */
export class RetryConfigError extends Error {
  public readonly code = "RETRY_CONFIG_INVALID";
  public readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid retry configuration: ${field} ${reason}`);
    this.name = "RetryConfigError";
    this.field = field;
    Error.captureStackTrace(this, RetryConfigError);
  }
}

function requireBoundedInteger(
  value: unknown,
  field: keyof RetryConfig,
  { min, max }: { min: number; max: number }
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RetryConfigError(field, "must be a finite number");
  }
  if (!Number.isInteger(value)) {
    throw new RetryConfigError(field, "must be an integer");
  }
  if (value < min || value > max) {
    throw new RetryConfigError(field, `must be between ${min} and ${max}`);
  }
  return value;
}

/**
 * Validate and merge a partial retry configuration over the defaults.
 *
 * Fails closed: every field is range-checked *before* the operation runs, so a
 * bad value throws synchronously-ish (as a rejected promise) rather than
 * silently turning into a tight loop (`initialDelayMs: 0`), a stalled
 * provider (`factor` < 1 with a huge `maxDelayMs`), or an effectively
 * unbounded retry count (`maxRetries: 1_000_000`).
 *
 * @throws RetryConfigError when any field is out of range.
 */
export function normalizeRetryConfig(
  config: Partial<RetryConfig> = {}
): RetryConfig {
  const merged: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

  const maxRetries = requireBoundedInteger(merged.maxRetries, "maxRetries", {
    min: 0,
    max: MAX_RETRIES_LIMIT,
  });
  const initialDelayMs = requireBoundedInteger(
    merged.initialDelayMs,
    "initialDelayMs",
    { min: 0, max: MAX_DELAY_MS_LIMIT }
  );
  const maxDelayMs = requireBoundedInteger(merged.maxDelayMs, "maxDelayMs", {
    min: 0,
    max: MAX_DELAY_MS_LIMIT,
  });

  if (typeof merged.factor !== "number" || !Number.isFinite(merged.factor)) {
    throw new RetryConfigError("factor", "must be a finite number");
  }
  // A factor below 1 shrinks each successive delay, so the backoff collapses
  // toward zero and stops actually backing off. Not accepted.
  if (merged.factor < 1) {
    throw new RetryConfigError("factor", "must be >= 1");
  }

  // A max below the initial delay silently truncates every delay to the
  // ceiling; catching it keeps the effective budget predictable.
  if (maxDelayMs < initialDelayMs) {
    throw new RetryConfigError("maxDelayMs", "must be >= initialDelayMs");
  }

  if (merged.useJitter !== undefined && typeof merged.useJitter !== "boolean") {
    throw new RetryConfigError("useJitter", "must be a boolean");
  }

  return {
    maxRetries,
    initialDelayMs,
    maxDelayMs,
    factor: merged.factor,
    useJitter: merged.useJitter !== false,
  };
}

/**
 * Shape of an HTTP-client error carrying a status code (axios/fetch style).
 */
interface HttpLikeError {
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown };
}

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate =
    (error as HttpLikeError).status ??
    (error as HttpLikeError).statusCode ??
    (error as HttpLikeError).response?.status;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

/**
 * Check if an error is considered retryable (transient).
 *
 * A structured HTTP status wins over message sniffing when one is present:
 * providers wrap the status in `status`/`statusCode`/`response.status`, and
 * message matching alone both misses statuses that never reach the message and
 * over-matches (an id like `4001` or a URL containing `/404` reads as a 4xx).
 *
 * Status policy:
 *   - 408 Request Timeout and 429 Too Many Requests -> retryable. Both are
 *     explicit "try again" signals, not a verdict on the request itself.
 *   - 4xx (anything else) -> permanent. The request is wrong; a retry replays
 *     the identical failure.
 *   - 5xx and everything else -> retryable.
 *
 * @param error - The error to classify
 * @returns True if the error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  // Caller cancellation is a decision, not a transient fault. Retrying an
  // aborted request (e.g. during shutdown) restarts work the caller already
  // cancelled, and with back-off it can outlast the very shutdown that
  // triggered it (#1109/#1111).
  if (isAbortError(error)) {
    return false;
  }

  // An explicit, typed verdict from the throwing component wins over any
  // inference below. Provider adapters classify their own failures precisely
  // (a `PrimaryProviderError` knows whether its own answer was malformed), and
  // inference from a message string both misses those and over-matches.
  const verdict = (error as { retryable?: unknown }).retryable;
  if (typeof verdict === "boolean") {
    return verdict;
  }

  const status = httpStatusOf(error);
  if (status !== undefined) {
    if (status === 408 || status === 429) {
      return true;
    }
    if (status >= 400 && status < 500) {
      return false;
    }
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
 * True when the error represents a caller cancellation rather than an upstream
 * fault. Deliberately does *not* cover `TimeoutError`: a deadline overrun is a
 * transient condition and stays retryable. A cancellation is a decision, so
 * retrying it restarts work the caller already gave up on.
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") {
    return true;
  }
  const message = error.message.toLowerCase();
  return (
    message.includes("abort") ||
    message.includes("cancelled") ||
    message.includes("canceled")
  );
}

/**
 * Wait for a specified duration.
 *
 * Negative or non-finite durations are treated as zero: `setTimeout` with a
 * negative value fires on the next tick anyway, and clamping keeps a bad delay
 * from silently becoming a busy-wait.
 *
 * @param ms - Duration in milliseconds
 */
export const wait = (ms: number) =>
  new Promise((resolve) =>
    setTimeout(resolve, Number.isFinite(ms) && ms > 0 ? ms : 0)
  );

/**
 * Execute an async operation with bounded retries and exponential backoff.
 *
 * The configuration is validated first (fail closed), so an invalid budget
 * rejects without ever calling `operation`.
 *
 * @param operation - The async operation to execute
 * @param config - Retry configuration
 * @param onRetry - Optional callback triggered on each retry
 * @returns Result of the operation
 * @throws RetryConfigError if the configuration is out of range
 * @throws The last error encountered if all retries fail
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  onRetry?: (error: Error, attempt: number, delayMs: number) => void
): Promise<T> {
  const fullConfig = normalizeRetryConfig(config);

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
