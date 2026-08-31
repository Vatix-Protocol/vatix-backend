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
 * Names of error classes that represent a *parse* failure — the payload
 * itself is malformed, not the transport. Retrying these forever (the gap
 * this module previously had no protection against: any Error whose
 * `.code`/message happened not to be network-shaped fell through
 * `isTransientError` as `false`, but nothing stopped a *future* transport
 * wrapper from re-throwing a parse error with a network-looking `.code`)
 * is always wrong — the bytes won't parse any differently on retry #50.
 */
const FATAL_ERROR_NAMES = new Set([
  "ResolutionParseError",
  "TradeParseError",
  "CollateralDepositedParseError",
  "MarketCreatedParseError",
  "RetryValidationError",
]);

/** Shape of an HTTP-client error carrying a status code (axios/fetch-wrapper style). */
interface HttpLikeError {
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown; headers?: Record<string, unknown> };
}

function httpStatusOf(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const e = err as HttpLikeError;
  const candidate = e.status ?? e.statusCode ?? e.response?.status;
  return typeof candidate === "number" ? candidate : undefined;
}

export type RetryClassification = "rate_limited" | "transient" | "fatal";

/**
 * Classify an error for retry purposes:
 *   - "fatal": never retry — parse errors, validation errors, 4xx (other
 *     than 429) responses. The request/payload is wrong; retrying can't fix it.
 *   - "rate_limited": HTTP 429 — retryable, but should back off more
 *     aggressively (and honor `Retry-After` when present) than a plain
 *     transient failure.
 *   - "transient": network-level failures and 5xx responses — safe to
 *     retry with standard exponential backoff.
 */
export function classifyError(err: unknown): RetryClassification {
  if (err instanceof Error && FATAL_ERROR_NAMES.has(err.name)) {
    return "fatal";
  }

  const status = httpStatusOf(err);
  if (status === 429) return "rate_limited";
  if (typeof status === "number") {
    return status >= 500 ? "transient" : "fatal";
  }

  if (!(err instanceof Error)) return "fatal";
  const code = (err as NodeJS.ErrnoException).code ?? "";
  return TRANSIENT_CODES.has(code) || TRANSIENT_CODES.has(err.message)
    ? "transient"
    : "fatal";
}

/**
 * Returns true when the error looks like a transient network failure
 * that is safe to retry. Retained for backwards compatibility with
 * existing callers; prefer `classifyError` for new code since it also
 * distinguishes rate limiting (429) from other transient failures and
 * never classifies a parse/validation error as retryable.
 */
export function isTransientError(err: unknown): boolean {
  const classification = classifyError(err);
  return classification === "transient" || classification === "rate_limited";
}

/** Extract a `Retry-After` (seconds) header value from an HTTP-like error, if present. */
function retryAfterMs(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const headers = (err as HttpLikeError).response?.headers;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  const seconds = typeof raw === "string" ? Number(raw) : undefined;
  return seconds !== undefined && Number.isFinite(seconds)
    ? seconds * 1000
    : undefined;
}

/**
 * Sleep for `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute a jittered exponential backoff delay for the given attempt.
 *
 * Uses "equal jitter": half of the exponential delay is guaranteed, the
 * other half is randomized. Backoff still grows with the attempt count,
 * but retries from many callers failing at the same time no longer land
 * on the same schedule (thundering herd).
 */
export function jitteredBackoffMs(
  baseDelayMs: number,
  attempt: number
): number {
  const exponential = baseDelayMs * 2 ** attempt;
  const half = exponential / 2;
  return half + Math.random() * half;
}

export interface RetryOptions {
  /** Maximum number of retry attempts after the first failure. */
  maxRetries: number;
  /** Base delay in ms; doubles on each attempt (exponential backoff). */
  retryDelayMs: number;
  /**
   * Multiplier applied to the base backoff for "rate_limited" (429)
   * classifications when the response carries no `Retry-After` header.
   * Rate limiting is a signal to slow down more than a bare network blip.
   */
  rateLimitBackoffMultiplier?: number;
  /**
   * Optional callback invoked before each retry sleep, for
   * metrics/correlation-id logging. Never receives the error's message —
   * only the classification and attempt number — so callers can log
   * safely without risking secrets leaking through error text.
   */
  onRetry?: (info: {
    attempt: number;
    classification: RetryClassification;
    delayMs: number;
  }) => void;
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
 * Execute `fn` with bounded retries, classifying failures via
 * `classifyError` instead of a single transient/non-transient split:
 *
 *   - "fatal" (parse errors, validation errors, non-429 4xx) never retries,
 *     regardless of remaining attempts — this is what stops a malformed
 *     payload from being retried forever.
 *   - "rate_limited" (429) retries with a longer backoff (honoring
 *     `Retry-After` when the response provides it).
 *   - "transient" (network failures, 5xx) retries with standard
 *     exponential backoff, as before.
 *
 * @throws {RetryValidationError} When options are invalid (statusCode 400).
 * @throws The last error when retries are exhausted or the error is fatal.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  validateRetryOptions(options);
  const { maxRetries, retryDelayMs, rateLimitBackoffMultiplier = 4, onRetry } =
    options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxRetries;
      const classification = classifyError(err);
      if (isLast || classification === "fatal") {
        throw err;
      }

      const delayMs =
        classification === "rate_limited"
          ? retryAfterMs(err) ??
            jitteredBackoffMs(retryDelayMs * rateLimitBackoffMultiplier, attempt)
          : jitteredBackoffMs(retryDelayMs, attempt);

      onRetry?.({ attempt, classification, delayMs });
      await sleep(delayMs);
    }
  }

  // Unreachable — satisfies TypeScript
  throw new Error("withRetry: exhausted retries");
}
