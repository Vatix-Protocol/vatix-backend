/**
 * Shared Timeout Utility
 *
 * Provides consistent timeout and cancellation handling for provider calls.
 * Used by all provider adapters to ensure uniform timeout behavior.
 *
 * @module apps/oracle/timeout-utils
 */

/**
 * Default timeout for provider calls (30 seconds).
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Minimum allowed timeout (1 second).
 */
export const MIN_TIMEOUT_MS = 1_000;

/**
 * Maximum allowed timeout (5 minutes).
 */
export const MAX_TIMEOUT_MS = 300_000;

/**
 * Timeout configuration options.
 */
export interface TimeoutConfig {
  /** Timeout duration in milliseconds */
  timeoutMs: number;
  /** Optional custom error message */
  errorMessage?: string;
}

/**
 * Result of a timed operation.
 */
export interface TimedResult<T> {
  /** The result value if the operation completed */
  value?: T;
  /** Whether the operation timed out */
  timedOut: boolean;
  /** Duration of the operation in milliseconds */
  durationMs: number;
  /** Error if the operation failed */
  error?: Error;
}

/**
 * Validate that a timeout value is within acceptable bounds.
 *
 * @param timeoutMs - Timeout value to validate
 * @returns The validated timeout value (clamped to bounds)
 */
export function validateTimeout(timeoutMs: number): number {
  if (typeof timeoutMs !== "number" || isNaN(timeoutMs)) {
    console.warn(
      `Invalid timeout value: ${timeoutMs}, using default: ${DEFAULT_TIMEOUT_MS}ms`
    );
    return DEFAULT_TIMEOUT_MS;
  }

  if (timeoutMs < MIN_TIMEOUT_MS) {
    console.warn(
      `Timeout ${timeoutMs}ms is below minimum ${MIN_TIMEOUT_MS}ms, clamping`
    );
    return MIN_TIMEOUT_MS;
  }

  if (timeoutMs > MAX_TIMEOUT_MS) {
    console.warn(
      `Timeout ${timeoutMs}ms exceeds maximum ${MAX_TIMEOUT_MS}ms, clamping`
    );
    return MAX_TIMEOUT_MS;
  }

  return timeoutMs;
}

/**
 * Create an AbortSignal that triggers after the specified timeout.
 * Combines with an existing signal if provided.
 *
 * @param timeoutMs - Timeout in milliseconds
 * @param existingSignal - Optional existing AbortSignal to combine with
 * @returns Object containing the combined signal and cleanup function
 */
export function createTimeoutSignal(
  timeoutMs: number,
  existingSignal?: AbortSignal
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const validatedTimeout = validateTimeout(timeoutMs);

  const timeoutId = setTimeout(() => {
    controller.abort(
      new Error(`Request timed out after ${validatedTimeout}ms`)
    );
  }, validatedTimeout);

  // Forward abort from existing signal
  const onExistingAbort = () => {
    clearTimeout(timeoutId);
    controller.abort(existingSignal?.reason);
  };

  if (existingSignal) {
    if (existingSignal.aborted) {
      clearTimeout(timeoutId);
      controller.abort(existingSignal.reason);
    } else {
      existingSignal.addEventListener("abort", onExistingAbort, {
        once: true,
      });
    }
  }

  const clear = () => {
    clearTimeout(timeoutId);
    if (existingSignal) {
      existingSignal.removeEventListener("abort", onExistingAbort);
    }
  };

  return { signal: controller.signal, clear };
}

/**
 * Execute an async operation with a timeout.
 * If the operation exceeds the timeout, it is aborted and a timeout error is returned.
 *
 * @param operation - Async operation to execute
 * @param config - Timeout configuration
 * @returns Promise resolving to a TimedResult
 */
export async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  config: TimeoutConfig
): Promise<TimedResult<T>> {
  const startTime = performance.now();
  const { signal, clear } = createTimeoutSignal(config.timeoutMs);

  try {
    const value = await Promise.race([
      operation(signal),
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(
              new Error(
                config.errorMessage ??
                  `Operation timed out after ${config.timeoutMs}ms`
              )
            );
          },
          { once: true }
        );
      }),
    ]);

    const durationMs = performance.now() - startTime;
    return { value, timedOut: false, durationMs };
  } catch (error) {
    const durationMs = performance.now() - startTime;
    const isTimeout =
      error instanceof Error &&
      (error.message.includes("timed out") ||
        error.message.includes("abort") ||
        error.message === config.errorMessage);

    if (isTimeout) {
      console.warn(
        `[TimeoutUtils] Operation timed out after ${config.timeoutMs}ms (${durationMs.toFixed(0)}ms elapsed)`
      );
    }

    return {
      timedOut: isTimeout,
      durationMs,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    clear();
  }
}

/**
 * Format duration for logging/metrics.
 *
 * @param durationMs - Duration in milliseconds
 * @returns Formatted duration string
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs.toFixed(0)}ms`;
  }
  return `${(durationMs / 1000).toFixed(2)}s`;
}
