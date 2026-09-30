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
 * Default upper bound for any single computed backoff delay. Prevents an
 * unbounded exponential (or a misconfigured base) from producing a delay
 * that effectively hangs the indexer.
 */
export const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Default jitter ratio: the randomized portion of the delay is drawn from
 * `[0, jitterRatio * delay]`. 0.5 = "equal jitter" (half guaranteed, half
 * randomized), which is the historical behavior of this module.
 */
export const DEFAULT_JITTER_RATIO = 0.5;

/**
 * Options controlling how a backoff delay is jittered and clamped.
 * All fields are optional; safe defaults preserve prior behavior.
 */
export interface JitterOptions {
  /**
   * Fraction of the base delay that is randomized, in `[0, 1]`. The
   * guaranteed portion is `1 - jitterRatio`. Defaults to
   * `DEFAULT_JITTER_RATIO` (0.5).
   */
  jitterRatio?: number;
  /**
   * Hard upper bound (ms) applied to the final delay. Defaults to
   * `DEFAULT_MAX_DELAY_MS`. Must be a non-negative finite number.
   */
  maxDelayMs?: number;
  /**
   * Injectable RNG returning a value in `[0, 1)`. Defaults to
   * `Math.random`. Exposed so tests can assert determinism and bounds.
   */
  random?: () => number;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Compute a jittered exponential backoff delay for the given attempt.
 *
 * Uses "equal jitter" by default: `(1 - jitterRatio)` of the exponential
 * delay is guaranteed, the remaining `jitterRatio` is randomized. Backoff
 * still grows with the attempt count, but retries from many callers
 * failing at the same time no longer land on the same schedule
 * (thundering herd).
 *
 * The result is always bounded: it is clamped to `[0, maxDelayMs]`, so a
 * large attempt count, a misconfigured base delay, or an out-of-range RNG
 * can never produce a negative or unbounded delay.
 */
export function jitteredBackoffMs(
  baseDelayMs: number,
  attempt: number,
  options: JitterOptions = {}
): number {
  const {
    jitterRatio = DEFAULT_JITTER_RATIO,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    random = Math.random,
  } = options;

  const safeBase = Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 0;
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  const exponential = safeBase * 2 ** safeAttempt;

  const ratio = clamp(Number.isFinite(jitterRatio) ? jitterRatio : DEFAULT_JITTER_RATIO, 0, 1);
  const guaranteed = exponential * (1 - ratio);
  const jitterSpan = exponential * ratio;

  const sample = random();
  const normalizedSample = Number.isFinite(sample) ? clamp(sample, 0, 1) : 0;
  const delay = guaranteed + normalizedSample * jitterSpan;

  const cap = Number.isFinite(maxDelayMs) && maxDelayMs >= 0 ? maxDelayMs : DEFAULT_MAX_DELAY_MS;
  return clamp(delay, 0, cap);
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
   * Fraction of each backoff delay that is randomized, in `[0, 1]`.
   * Defaults to `DEFAULT_JITTER_RATIO`. Set to 0 to disable jitter.
   */
  jitterRatio?: number;
  /**
   * Hard upper bound (ms) applied to every computed backoff delay.
   * Defaults to `DEFAULT_MAX_DELAY_MS`.
   */
  maxDelayMs?: number;
  /**
   * Injectable RNG returning a value in `[0, 1)`. Defaults to
   * `Math.random`. Exposed for deterministic tests.
   */
  random?: () => number;
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

/**
 * Stable error code surfaced when retries are exhausted on a transient
 * failure. Fail-closed: callers must not treat this as an empty result.
 */
export const RETRY_EXHAUSTED = "RETRY_EXHAUSTED";

/**
 * Thrown when a transient error persists past the configured retry budget.
 * Carries a stable `code` and the underlying cause for observability.
 */
export class RetryExhaustedError extends Error {
  readonly code = RETRY_EXHAUSTED;
  readonly statusCode = 503;
  readonly attempts: number;
  constructor(attempts: number, cause?: unknown) {
    super(
      `retries exhausted after ${attempts} attempt(s): ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
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
  if (
    options.jitterRatio !== undefined &&
    (!Number.isFinite(options.jitterRatio) ||
      options.jitterRatio < 0 ||
      options.jitterRatio > 1)
  ) {
    throw new RetryValidationError("jitterRatio must be a number in [0, 1]");
  }
  if (
    options.maxDelayMs !== undefined &&
    (!Number.isFinite(options.maxDelayMs) || options.maxDelayMs < 0)
  ) {
    throw new RetryValidationError("maxDelayMs must be a non-negative number");
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
 * Every computed delay is jittered and clamped to `[0, maxDelayMs]`.
 *
 * @throws {RetryValidationError} When options are invalid (statusCode 400).
 * @throws {RetryExhaustedError} When transient retries are exhausted
 *   (statusCode 503, code RETRY_EXHAUSTED) — fail-closed.
 * @throws The original error when it is non-transient (not retried).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  validateRetryOptions(options);
  const {
    maxRetries,
    retryDelayMs,
    rateLimitBackoffMultiplier = 4,
    jitterRatio,
    maxDelayMs,
    random,
    onRetry,
  } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isLast = attempt === maxRetries;
      const classification = classifyError(err);
      if (isLast || classification === "fatal") {
        // Fail-closed: never swallow the failure. Fatal errors are rethrown
        // as-is; exhausted transient retries surface a stable error code.
        if (classification === "fatal") throw err;
        throw new RetryExhaustedError(attempt + 1, err);
      }

      const base =
        classification === "rate_limited"
          ? retryDelayMs * rateLimitBackoffMultiplier
          : retryDelayMs;

      const retryAfter = retryAfterMs(err);
      const delayMs =
        retryAfter !== undefined
          ? clamp(retryAfter, 0, maxDelayMs ?? DEFAULT_MAX_DELAY_MS)
          : jitteredBackoffMs(base, attempt, {
              jitterRatio,
              maxDelayMs,
              random,
            });

      onRetry?.({ attempt, classification, delayMs });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop always returns or throws. Kept for type-safety.
  throw new RetryExhaustedError(maxRetries + 1);
}
