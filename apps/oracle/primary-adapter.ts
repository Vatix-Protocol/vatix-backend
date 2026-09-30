/**
 * Primary Provider Adapter
 *
 * The default provider adapter used for market resolution.
 * Implements the ProviderAdapter interface with per-request timeout and
 * retry configuration. Retries are applied at the adapter level for
 * transient errors (network failures, 5xx responses, timeouts).
 *
 * @module apps/oracle/primary-adapter
 */

import type {
  ProviderAdapter,
  ProviderResult,
  ResolutionRequest,
} from "./provider-adapter.js";
import {
  withTimeout,
  validateTimeout,
  DEFAULT_TIMEOUT_MS,
  PRIMARY_PROVIDER_TIMEOUT_POLICY_MS,
} from "./timeout-utils.js";
import { withRetry, type RetryConfig } from "./retry-utils.js";
import { oraclePrimaryProviderAttemptsTotal } from "../../src/services/metrics.js";

/**
 * Primary provider adapter configuration.
 */
export interface PrimaryAdapterConfig {
  /** Base URL for the primary provider API */
  baseUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /** Request timeout in milliseconds (per attempt) */
  timeoutMs?: number;
  /**
   * Retry configuration applied to each resolution request.
   * Defaults to no retries (maxRetries: 0).
   * Override to enable automatic retries on transient failures.
   */
  retryConfig?: Partial<RetryConfig>;
  /** Optional fetch implementation for tests */
  fetchFn?: typeof fetch;
}

export type PrimaryProviderErrorType =
  | "AUTHENTICATION"
  | "INVALID_RESPONSE"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "UPSTREAM";

/**
 * Which failure types are worth another attempt.
 *
 * Only genuinely transient conditions are retried. `INVALID_RESPONSE`,
 * `NOT_FOUND` and `AUTHENTICATION` are deterministic: the provider will answer
 * identically on every attempt, so retrying them just burns the retry budget,
 * the provider's rate limit, and the resolution deadline before failing with
 * exactly the same answer. `TIMEOUT`, `RATE_LIMIT` and `UPSTREAM` are the
 * transient set.
 */
const RETRYABLE_PRIMARY_ERROR_TYPES: ReadonlySet<PrimaryProviderErrorType> =
  new Set<PrimaryProviderErrorType>(["TIMEOUT", "RATE_LIMIT", "UPSTREAM"]);

export class PrimaryProviderError extends Error {
  /**
   * Structured HTTP status when the failure came from a response, so
   * `isRetryableError` can apply its status policy instead of sniffing this
   * error's message text.
   */
  readonly status?: number;

  /**
   * Typed retry verdict. `isRetryableError` consults this before any
   * message/status inference, so the adapter's own classification of a
   * deterministic failure is never overridden.
   */
  readonly retryable: boolean;

  constructor(
    public readonly type: PrimaryProviderErrorType,
    message: string,
    public readonly cause?: unknown,
    status?: number
  ) {
    super(message);
    this.name = "PrimaryProviderError";
    this.status = status;
    this.retryable = RETRYABLE_PRIMARY_ERROR_TYPES.has(type);
  }
}

interface PrimaryProviderResponse {
  outcome: boolean;
  confidence: number;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Primary provider adapter.
 * This is the default adapter used for market resolution.
 */
export class PrimaryAdapter implements ProviderAdapter {
  private readonly source = "primary";
  private config: PrimaryAdapterConfig;
  private readonly fetchFn: typeof fetch;

  constructor(config: PrimaryAdapterConfig) {
    this.config = {
      // Default to the documented per-role policy rather than the generic
      // constant, so an adapter constructed without an explicit timeout
      // behaves as `docs/architecture.md` describes instead of merely
      // happening to share the same number.
      timeoutMs: PRIMARY_PROVIDER_TIMEOUT_POLICY_MS,
      retryConfig: { maxRetries: 0 },
      ...config,
    };
    // Fail fast (in production) rather than silently running with a timeout
    // that does not match the documented primary-provider policy — the same
    // treatment `FallbackAdapter` gives its own policy constant.
    this.config.timeoutMs = validateTimeout(this.config.timeoutMs);
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Resolve a market using the primary provider.
   *
   * Applies per-request timeout and retry configuration. The timeout is
   * applied per attempt; retries use exponential back-off as configured by
   * `retryConfig`. Request-level `timeoutMs` and `retryConfig` take
   * precedence over adapter-level defaults.
   *
   * @param request - Resolution request parameters
   * @returns Provider result with source attribution
   */
  async resolve(request: ResolutionRequest): Promise<ProviderResult> {
    // Validate the effective timeout the same way the fallback adapter does,
    // so a caller-supplied out-of-policy `timeoutMs` cannot silently widen (or
    // collapse) the primary provider's budget.
    const timeoutMs = validateTimeout(
      request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );

    // Per-request retryConfig overrides adapter-level default
    const effectiveRetryConfig: Partial<RetryConfig> = {
      ...this.config.retryConfig,
      ...(request.retryConfig ?? {}),
    };

    try {
      // `await` is load-bearing: `return withRetry(...)` returns a pending
      // promise, so the `try` block exits immediately and a rejection arriving
      // later is rethrown to the caller *without* ever running this `catch`.
      // Every primary failure would then be invisible to
      // `vatix_oracle_primary_provider_attempts_total`, and a flapping or
      // rate-limited provider would look healthy on the money path.
      return await withRetry(async () => {
        const timedResult = await withTimeout<ProviderResult>(
          async (signal) => this.fetchFromProvider(request, signal),
          {
            timeoutMs,
            errorMessage: `Primary provider timed out after ${timeoutMs}ms`,
            // Honour caller cancellation (poll-loop shutdown) as well as the
            // timeout, so a shutdown does not have to wait out a hung primary.
            signal: request.signal,
          }
        );

        if (timedResult.timedOut) {
          throw new PrimaryProviderError(
            "TIMEOUT",
            timedResult.error?.message ?? "Primary provider request timed out",
            timedResult.error
          );
        }

        if (timedResult.error) {
          throw this.mapProviderError(timedResult.error);
        }

        return timedResult.value!;
      }, effectiveRetryConfig);
    } catch (error) {
      // Counted per *attempt*, on a dedicated counter, because
      // `oracleProviderAttemptsTotal` is already incremented once per
      // resolve() by OracleService and reusing it would double-count. This
      // series is what makes "the primary provider is flapping" visible during
      // a retry burst, before resolve() as a whole has given up.
      const mapped = this.mapProviderError(
        error instanceof Error ? error : new Error(String(error))
      );
      oraclePrimaryProviderAttemptsTotal.labels(mapped.type).inc();
      throw mapped;
    }
  }

  /**
   * Check if the primary provider is healthy.
   *
   * @returns True if the provider is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const timedResult = await withTimeout<boolean>(
        async (signal) => {
          const response = await this.fetchFn(
            new URL("/health", this.config.baseUrl),
            {
              headers: this.getHeaders(),
              signal,
            }
          );
          return response.ok;
        },
        {
          timeoutMs: 5_000,
          errorMessage: "Primary provider health check timed out",
        }
      );

      return timedResult.value ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Get the provider source identifier.
   *
   * @returns "primary"
   */
  getSource(): string {
    return this.source;
  }

  /**
   * Fetch resolution data from the primary provider.
   * Placeholder for actual HTTP request logic.
   */
  private async fetchFromProvider(
    request: ResolutionRequest,
    signal: AbortSignal
  ): Promise<ProviderResult> {
    const url = new URL("/resolve", this.config.baseUrl);
    url.searchParams.set("marketId", request.marketId);
    url.searchParams.set("oracleAddress", request.oracleAddress);

    const response = await this.fetchFn(url, {
      headers: this.getHeaders(),
      signal,
    });

    if (!response.ok) {
      throw new PrimaryProviderError(
        this.mapStatus(response.status),
        `Primary provider returned HTTP ${response.status}`,
        undefined,
        response.status
      );
    }

    const payload = (await response.json()) as Partial<PrimaryProviderResponse>;
    if (
      typeof payload.outcome !== "boolean" ||
      // `Number.isFinite` rather than `typeof === "number"`: JSON has no NaN
      // literal, but a provider returning a non-finite value (or `null`, which
      // `typeof` reports as "object" and would slip past a truthiness check)
      // must not become a confidence score that silently passes the
      // `>= 0 && <= 1` range check below and reaches the signing path.
      !Number.isFinite(payload.confidence) ||
      payload.confidence! < 0 ||
      payload.confidence! > 1
    ) {
      throw new PrimaryProviderError(
        "INVALID_RESPONSE",
        "Primary provider response is missing a valid outcome or confidence"
      );
    }

    oraclePrimaryProviderAttemptsTotal.labels("OK").inc();

    return {
      outcome: payload.outcome,
      // Non-null assertions match the guard above: `Number.isFinite` is not a
      // TypeScript type predicate, so it does not narrow `number | undefined`
      // the way the surrounding `typeof` checks do.
      confidence: payload.confidence!,
      confidenceMetadata: {
        score: payload.confidence!,
        method: "primary-provider",
      },
      source: this.source,
      sourceMetadata: {
        provider: this.source,
      },
      timestamp: payload.timestamp ?? new Date().toISOString(),
      metadata: {
        provider: "primary",
        marketId: request.marketId,
        ...payload.metadata,
      },
    };
  }

  private getHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      ...(this.config.apiKey
        ? { Authorization: `Bearer ${this.config.apiKey}` }
        : {}),
    };
  }

  private mapStatus(status: number): PrimaryProviderErrorType {
    if (status === 401 || status === 403) return "AUTHENTICATION";
    if (status === 404) return "NOT_FOUND";
    if (status === 429) return "RATE_LIMIT";
    return "UPSTREAM";
  }

  private mapProviderError(error: Error): PrimaryProviderError {
    if (error instanceof PrimaryProviderError) {
      return error;
    }

    if (error.name === "AbortError" || error.message.includes("timed out")) {
      return new PrimaryProviderError("TIMEOUT", error.message, error);
    }

    return new PrimaryProviderError("UPSTREAM", error.message, error);
  }
}
