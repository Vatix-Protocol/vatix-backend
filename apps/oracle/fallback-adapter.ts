/**
 * Secondary Fallback Provider Adapter
 *
 * Implements the same ProviderAdapter interface as the primary adapter.
 * Accepts an ordered list of fallback provider URLs; the first one to
 * return a valid response wins. Each provider is retried independently
 * before the chain advances to the next entry.
 *
 * ## Invariants (#1109)
 *
 * 1. **Fail closed.** If every provider in the chain fails, `resolve()`
 *    throws `FallbackProviderError` with type `ALL_PROVIDERS_FAILED`. It
 *    never returns a partial, stale, or default result.
 * 2. **Bounded in time and attempts.** Every provider attempt is raced
 *    against `timeoutMs`, and the whole chain against `chainTimeoutMs`.
 *    Without the chain deadline, N providers x timeout x retries could hold
 *    the sequential poll cycle for many minutes (#1110).
 * 3. **Bounded in work.** The chain is capped at `MAX_FALLBACK_PROVIDERS`
 *    entries, so a misconfigured `ORACLE_FALLBACK_URLS` cannot amplify
 *    outbound request volume (griefing / thundering-herd defence).
 * 4. **No secret in errors, logs, or metric labels.** Provider identity in
 *    an error message or a Prometheus label goes through `providerLabel()`,
 *    which is a configured `source` or a credential-stripped origin. An
 *    `apiKey` is never part of a message, label, or log field.
 * 5. **Cancellation propagates.** A caller-supplied `request.signal`
 *    (poll-loop shutdown) aborts in-flight provider requests instead of
 *    letting them resolve after the process is going down.
 *
 * @module apps/oracle/fallback-adapter
 */

import type {
  ProviderAdapter,
  ProviderResult,
  ResolutionRequest,
} from "./provider-adapter.js";
import {
  withTimeout,
  validateTimeout,
  FALLBACK_PROVIDER_TIMEOUT_POLICY_MS,
} from "./timeout-utils.js";
import { withRetry, type RetryConfig } from "./retry-utils.js";
import { oracleFallbackChainAttemptsTotal } from "../../src/services/metrics.js";

/**
 * Maximum number of providers accepted in a single fallback chain. Each entry
 * is an outbound HTTP request per market per cycle, so an unbounded list is a
 * request-amplification vector against third-party providers. Extra entries
 * are a configuration bug and are rejected at construction rather than
 * silently truncated.
 */
export const MAX_FALLBACK_PROVIDERS = 8;

/**
 * Default ceiling for the *entire* chain, not per provider: the per-provider
 * policy multiplied by the maximum chain length, so even a fully-failing chain
 * fails closed inside a window the sequential poll loop can survive.
 */
export const FALLBACK_CHAIN_TIMEOUT_POLICY_MS =
  FALLBACK_PROVIDER_TIMEOUT_POLICY_MS * MAX_FALLBACK_PROVIDERS;

/** Upper bound on the aggregate `ALL_PROVIDERS_FAILED` message length. */
const MAX_ERROR_MESSAGE_CHARS = 2_000;

/**
 * Deadline for a single provider's `/health` probe. Kept well below the
 * per-provider resolution timeout: a health check answers the readiness
 * question, so a slow one must not consume a whole resolution budget.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

/**
 * Configuration for a single provider in the fallback chain.
 */
export interface FallbackProviderConfig {
  /** Base URL for the provider API */
  url: string;
  /** API key for authentication */
  apiKey?: string;
  /** Source identifier used in ProviderResult attribution */
  source?: string;
}

/**
 * Fallback adapter configuration.
 */
export interface FallbackAdapterConfig {
  /**
   * Ordered list of fallback providers to try.
   * The first provider that returns a valid response wins;
   * providers are tried in array order.
   */
  providers: FallbackProviderConfig[];
  /** Request timeout in milliseconds (applied per provider) */
  timeoutMs?: number;
  /**
   * Deadline in milliseconds for the entire provider chain, not one provider.
   * Without it, a chain of N providers each consuming `timeoutMs` plus retries
   * can occupy a single resolution for minutes — long enough to stall the
   * sequential poll cycle for every market (#1110). Defaults to
   * `FALLBACK_CHAIN_TIMEOUT_POLICY_MS`.
   */
  chainTimeoutMs?: number;
  /** Retry configuration applied per provider before advancing the chain */
  retryConfig?: Partial<RetryConfig>;
  /** Optional fetch implementation — inject in tests to avoid real HTTP */
  fetchFn?: typeof fetch;
}

export type FallbackProviderErrorType =
  | "AUTHENTICATION"
  | "INVALID_RESPONSE"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "UPSTREAM"
  | "ALL_PROVIDERS_FAILED";

export class FallbackProviderError extends Error {
  constructor(
    public readonly type: FallbackProviderErrorType,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "FallbackProviderError";
  }
}

interface FallbackProviderResponse {
  outcome: boolean;
  confidence: number;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Secondary fallback provider adapter.
 * Walks the provider chain in order, returning the first successful result.
 */
/**
 * Derive an operator-safe identifier for a provider.
 *
 * Prefers the configured `source` (e.g. `fallback-1`). When absent, the raw
 * URL is reduced to `scheme://host[:port]` with any userinfo (which can carry
 * a basic-auth credential) and query string (which can carry an API key)
 * stripped. The result is bounded in length so a hostile or accidental URL
 * cannot blow up metric cardinality or log volume.
 */
export function providerLabel(provider: FallbackProviderConfig): string {
  if (provider.source && provider.source.trim() !== "") {
    return provider.source;
  }

  try {
    const url = new URL(provider.url);
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//${url.hostname}${port}`;
  } catch {
    // Not parseable as a URL — surface a fixed marker rather than the raw
    // string, which could contain a credential.
    return "invalid-url";
  }
}

export class FallbackAdapter implements ProviderAdapter {
  private readonly config: FallbackAdapterConfig;
  private readonly fetchFn: typeof fetch;

  constructor(config: FallbackAdapterConfig) {
    if (!config.providers || config.providers.length === 0) {
      throw new Error("FallbackAdapter requires at least one provider");
    }
    if (config.providers.length > MAX_FALLBACK_PROVIDERS) {
      // Reject rather than truncate: silently dropping entries would make the
      // effective chain differ from what the operator configured.
      throw new Error(
        `FallbackAdapter accepts at most ${MAX_FALLBACK_PROVIDERS} providers, got ${config.providers.length}`
      );
    }
    this.config = {
      timeoutMs: FALLBACK_PROVIDER_TIMEOUT_POLICY_MS,
      ...config,
    };
    // Fail fast (in production) rather than silently running with a
    // timeout that doesn't match the documented fallback policy.
    this.config.timeoutMs = validateTimeout(this.config.timeoutMs);

    // The chain budget must cover at least one full provider attempt, so the
    // default is raised when a (clamped) per-provider timeout exceeds it. An
    // explicitly configured budget below the per-provider timeout is a
    // contradiction and is rejected.
    const defaultChainTimeoutMs = Math.max(
      FALLBACK_CHAIN_TIMEOUT_POLICY_MS,
      this.config.timeoutMs
    );
    this.config.chainTimeoutMs = validateTimeout(
      config.chainTimeoutMs ?? defaultChainTimeoutMs
    );
    if (this.config.chainTimeoutMs < this.config.timeoutMs) {
      throw new Error(
        `FallbackAdapter chainTimeoutMs (${this.config.chainTimeoutMs}) must be >= timeoutMs (${this.config.timeoutMs})`
      );
    }

    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Resolve a market by walking the provider chain.
   * Each provider is retried per retryConfig before advancing.
   *
   * The walk is bounded twice: each provider gets at most `timeoutMs`, and the
   * whole chain gets `chainTimeoutMs`. When the chain deadline expires the walk
   * stops and fails closed with `ALL_PROVIDERS_FAILED` rather than continuing to
   * spend the poll cycle on providers that can no longer contribute in time.
   */
  async resolve(request: ResolutionRequest): Promise<ProviderResult> {
    const timeoutMs = validateTimeout(
      request.timeoutMs ??
        this.config.timeoutMs ??
        FALLBACK_PROVIDER_TIMEOUT_POLICY_MS
    );
    const chainTimeoutMs = this.config.chainTimeoutMs!;
    const deadline = Date.now() + chainTimeoutMs;
    const errors: Error[] = [];

    for (const provider of this.config.providers) {
      // Never let a provider label carry a credential or unbounded text into
      // a metric label or an error message.
      const label = providerLabel(provider);
      const remainingMs = deadline - Date.now();

      if (remainingMs <= 0) {
        errors.push(
          new FallbackProviderError(
            "TIMEOUT",
            `Fallback chain deadline of ${chainTimeoutMs}ms expired before provider ${label} was tried`
          )
        );
        break;
      }

      // A provider never gets more than its own timeout, and never more than
      // what is left of the chain budget.
      const attemptTimeoutMs = Math.min(timeoutMs, remainingMs);

      try {
        const timedResult = await withTimeout<ProviderResult>(
          async (signal) =>
            withRetry(
              () => this.fetchFromProvider(provider, request, signal),
              this.config.retryConfig
            ),
          {
            timeoutMs: attemptTimeoutMs,
            errorMessage: `Fallback provider ${label} timed out after ${attemptTimeoutMs}ms`,
            signal: request.signal,
          }
        );

        if (timedResult.timedOut) {
          oracleFallbackChainAttemptsTotal.labels(label, "failure").inc();
          errors.push(
            timedResult.error ??
              new FallbackProviderError(
                "TIMEOUT",
                `Fallback provider ${label} timed out after ${timeoutMs}ms`
              )
          );
          continue;
        }

        if (timedResult.error) {
          oracleFallbackChainAttemptsTotal.labels(label, "failure").inc();
          errors.push(timedResult.error);
          continue;
        }

        oracleFallbackChainAttemptsTotal.labels(label, "success").inc();
        return timedResult.value!;
      } catch (err) {
        oracleFallbackChainAttemptsTotal.labels(label, "failure").inc();
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Bound the aggregate message: a long chain of verbose upstream errors must
    // not turn one resolution failure into a multi-kilobyte log line. Each
    // per-provider error keeps its own type in the chain error's `errors` list.
    const summary = errors
      .map((e) => e.message)
      .join("; ")
      .slice(0, MAX_ERROR_MESSAGE_CHARS);

    throw new FallbackProviderError(
      "ALL_PROVIDERS_FAILED",
      `All fallback providers failed for market ${request.marketId} after ${errors.length} attempt(s): ${summary}`,
      errors.length > 0 ? errors[errors.length - 1] : undefined
    );
  }

  /**
   * Returns true if any provider in the chain responds healthy.
   */
  async healthCheck(): Promise<boolean> {
    for (const provider of this.config.providers) {
      try {
        const timedResult = await withTimeout<boolean>(
          async (signal) => {
            const response = await this.fetchFn(
              new URL("/health", provider.url),
              { headers: this.getHeaders(provider), signal }
            );
            return response.ok;
          },
          {
            timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
            errorMessage: `Fallback provider ${providerLabel(provider)} health check timed out`,
          }
        );

        if (timedResult.value === true) return true;
      } catch {
        // try next provider
      }
    }
    return false;
  }

  getSource(): string {
    return "fallback";
  }

  private async fetchFromProvider(
    provider: FallbackProviderConfig,
    request: ResolutionRequest,
    signal: AbortSignal
  ): Promise<ProviderResult> {
    const label = providerLabel(provider);
    const url = new URL("/resolve", provider.url);
    url.searchParams.set("marketId", request.marketId);
    url.searchParams.set("oracleAddress", request.oracleAddress);

    const response = await this.fetchFn(url, {
      headers: this.getHeaders(provider),
      signal,
    });

    if (!response.ok) {
      throw new FallbackProviderError(
        this.mapStatus(response.status),
        `Fallback provider ${label} returned HTTP ${response.status}`
      );
    }

    let payload: Partial<FallbackProviderResponse>;
    try {
      payload = (await response.json()) as Partial<FallbackProviderResponse>;
    } catch (error) {
      // A 200 with a non-JSON body (an HTML error page from a proxy, a
      // truncated response) is an invalid response, not a transient upstream
      // blip — classify it so the chain advances instead of burning retries.
      throw new FallbackProviderError(
        "INVALID_RESPONSE",
        `Fallback provider ${label} returned a non-JSON body`,
        error
      );
    }

    if (
      typeof payload.outcome !== "boolean" ||
      typeof payload.confidence !== "number" ||
      !Number.isFinite(payload.confidence) ||
      payload.confidence < 0 ||
      payload.confidence > 1
    ) {
      throw new FallbackProviderError(
        "INVALID_RESPONSE",
        `Fallback provider ${label} response is missing a valid outcome or confidence`
      );
    }

    // The provider-reported timestamp is untrusted input that is persisted
    // onto OracleReport.createdAt; refuse an unparseable one rather than
    // writing an invalid date.
    if (
      payload.timestamp !== undefined &&
      Number.isNaN(Date.parse(payload.timestamp))
    ) {
      throw new FallbackProviderError(
        "INVALID_RESPONSE",
        `Fallback provider ${label} returned an unparseable timestamp`
      );
    }

    const source = provider.source ?? "fallback";

    return {
      outcome: payload.outcome,
      confidence: payload.confidence,
      confidenceMetadata: {
        score: payload.confidence,
        method: "fallback-provider",
      },
      source,
      sourceMetadata: { provider: source },
      timestamp: payload.timestamp ?? new Date().toISOString(),
      metadata: {
        provider: source,
        marketId: request.marketId,
        ...payload.metadata,
      },
    };
  }

  private getHeaders(provider: FallbackProviderConfig): Record<string, string> {
    return {
      Accept: "application/json",
      ...(provider.apiKey
        ? { Authorization: `Bearer ${provider.apiKey}` }
        : {}),
    };
  }

  private mapStatus(status: number): FallbackProviderErrorType {
    if (status === 401 || status === 403) return "AUTHENTICATION";
    if (status === 404) return "NOT_FOUND";
    if (status === 429) return "RATE_LIMIT";
    return "UPSTREAM";
  }
}
