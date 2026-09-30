/**
 * Secondary Fallback Provider Adapter
 *
 * Implements the same ProviderAdapter interface as the primary adapter.
 * Accepts an ordered list of fallback provider URLs; the first one to
 * return a valid response wins. Each provider is retried independently
 * before the chain advances to the next entry.
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
 * Stable error codes for fallback adapter switch conditions.
 * These are part of the public contract and must not change without a
 * corresponding docs/runbook update.
 */
export type FallbackSwitchErrorCode =
  | "FALLBACK_SWITCH_UNAUTHORIZED"
  | "FALLBACK_SWITCH_INVALID_REQUEST"
  | "FALLBACK_SWITCH_DEPENDENCY_UNAVAILABLE"
  | "FALLBACK_SWITCH_REPLAYED"
  | "FALLBACK_SWITCH_DISABLED";

/**
 * Error raised when a fallback switch condition is not satisfied.
 * Carries a stable `code` and a `correlationId` for ops tracing.
 */
export class FallbackSwitchError extends Error {
  constructor(
    public readonly code: FallbackSwitchErrorCode,
    message: string,
    public readonly correlationId: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "FallbackSwitchError";
  }
}

/**
 * Trusted caller roles permitted to trigger a fallback switch.
 * Deny-by-default: any role not listed here is rejected.
 */
export type FallbackSwitchRole = "oracle-admin" | "oracle-operator";

const ALLOWED_SWITCH_ROLES: ReadonlySet<FallbackSwitchRole> = new Set([
  "oracle-admin",
  "oracle-operator",
]);

/**
 * A request to switch the active oracle adapter to the fallback chain.
 */
export interface FallbackSwitchRequest {
  /** Caller role — must be an allowed privileged role */
  role: FallbackSwitchRole | string;
  /** Idempotency key; replays with the same key are rejected */
  idempotencyKey: string;
  /** Correlation id propagated through logs/metrics */
  correlationId?: string;
  /** Reason for the switch, recorded for audit */
  reason?: string;
}

/**
 * Result of a successful fallback switch.
 */
export interface FallbackSwitchResult {
  switched: true;
  correlationId: string;
  activeSource: string;
}

/**
 * Dependency health probe used to fail closed on writes when a
 * dependency (RPC/DB/Redis) is unavailable.
 */
export interface FallbackSwitchDependencies {
  /** Returns true when the dependency is reachable and healthy */
  isHealthy: () => Promise<boolean>;
}

/**
 * Options for {@link FallbackAdapter.switchToFallback}.
 */
export interface FallbackSwitchOptions {
  /** Kill-switch: when false, all switches are denied */
  enabled?: boolean;
  /** Dependency health probe; when unhealthy the switch fails closed */
  dependencies?: FallbackSwitchDependencies;
  /** Clock injection for deterministic tests */
  now?: () => number;
}

/**
 * Secondary fallback provider adapter.
 * Walks the provider chain in order, returning the first successful result.
 */
export class FallbackAdapter implements ProviderAdapter {
  private readonly config: FallbackAdapterConfig;
  private readonly fetchFn: typeof fetch;
  private readonly seenIdempotencyKeys = new Set<string>();
  private activeSource = "primary";

  constructor(config: FallbackAdapterConfig) {
    if (!config.providers || config.providers.length === 0) {
      throw new Error("FallbackAdapter requires at least one provider");
    }
    this.config = {
      timeoutMs: FALLBACK_PROVIDER_TIMEOUT_POLICY_MS,
      ...config,
    };
    // Fail fast (in production) rather than silently running with a
    // timeout that doesn't match the documented fallback policy.
    this.config.timeoutMs = validateTimeout(this.config.timeoutMs);
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Switch the active oracle adapter to the fallback chain.
   *
   * Conditions enforced (fail-closed):
   * 1. Kill-switch must be enabled.
   * 2. Caller role must be an allowed privileged role (deny-by-default).
   * 3. Request must carry a non-empty idempotency key that has not been
   *    seen before (replay protection).
   * 4. Dependency health probe must report healthy; otherwise the write
   *    is refused rather than silently proceeding.
   */
  async switchToFallback(
    request: FallbackSwitchRequest,
    options: FallbackSwitchOptions = {}
  ): Promise<FallbackSwitchResult> {
    const correlationId = request.correlationId ?? this.newCorrelationId(options);

    if (options.enabled === false) {
      throw new FallbackSwitchError(
        "FALLBACK_SWITCH_DISABLED",
        "Fallback switch is disabled by kill-switch",
        correlationId
      );
    }

    if (!ALLOWED_SWITCH_ROLES.has(request.role as FallbackSwitchRole)) {
      throw new FallbackSwitchError(
        "FALLBACK_SWITCH_UNAUTHORIZED",
        `Role '${request.role}' is not authorized to switch the fallback adapter`,
        correlationId
      );
    }

    if (
      typeof request.idempotencyKey !== "string" ||
      request.idempotencyKey.trim().length === 0
    ) {
      throw new FallbackSwitchError(
        "FALLBACK_SWITCH_INVALID_REQUEST",
        "Fallback switch requires a non-empty idempotencyKey",
        correlationId
      );
    }

    if (this.seenIdempotencyKeys.has(request.idempotencyKey)) {
      throw new FallbackSwitchError(
        "FALLBACK_SWITCH_REPLAYED",
        `Fallback switch idempotencyKey '${request.idempotencyKey}' was already used`,
        correlationId
      );
    }

    if (options.dependencies) {
      let healthy = false;
      try {
        healthy = await options.dependencies.isHealthy();
      } catch (err) {
        throw new FallbackSwitchError(
          "FALLBACK_SWITCH_DEPENDENCY_UNAVAILABLE",
          "Fallback switch dependency probe failed",
          correlationId,
          err
        );
      }
      if (!healthy) {
        throw new FallbackSwitchError(
          "FALLBACK_SWITCH_DEPENDENCY_UNAVAILABLE",
          "Fallback switch refused: dependency unavailable (fail-closed)",
          correlationId
        );
      }
    }

    // Record the key only after all conditions pass so a rejected request
    // does not consume the caller's idempotency key.
    this.seenIdempotencyKeys.add(request.idempotencyKey);
    this.activeSource = "fallback";

    return {
      switched: true,
      correlationId,
      activeSource: this.activeSource,
    };
  }

  /**
   * Resolve a market by walking the provider chain.
   * Each provider is retried per retryConfig before advancing.
   */
  async resolve(request: ResolutionRequest): Promise<ProviderResult> {
    const timeoutMs = validateTimeout(
      request.timeoutMs ??
        this.config.timeoutMs ??
        FALLBACK_PROVIDER_TIMEOUT_POLICY_MS
    );
    const errors: Error[] = [];

    for (const provider of this.config.providers) {
      const label = provider.source ?? provider.url;
      try {
        const timedResult = await withTimeout<ProviderResult>(
          async (signal) =>
            withRetry(
              () => this.fetchFromProvider(provider, request, signal),
              this.config.retryConfig
            ),
          {
            timeoutMs,
            errorMessage: `Fallback provider ${label} timed out after ${timeoutMs}ms`,
          }
        );

        if (timedResult.timedOut) {
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
          errors.push(timedResult.error);
          continue;
        }

        return timedResult.value!;
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    throw new FallbackProviderError(
      "ALL_PROVIDERS_FAILED",
      `All fallback providers failed: ${errors.map((e) => e.message).join("; ")}`
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
            timeoutMs: 5_000,
            errorMessage: "Fallback provider health check timed out",
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

  private newCorrelationId(options: FallbackSwitchOptions): string {
    const now = options.now ?? Date.now;
    return `fb-${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  private async fetchFromProvider(
    provider: FallbackProviderConfig,
    request: ResolutionRequest,
    signal: AbortSignal
  ): Promise<ProviderResult> {
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
        `Fallback provider ${provider.source ?? provider.url} returned HTTP ${response.status}`
      );
    }

    const payload =
      (await response.json()) as Partial<FallbackProviderResponse>;

    if (
      typeof payload.outcome !== "boolean" ||
      typeof payload.confidence !== "number" ||
      payload.confidence < 0 ||
      payload.confidence > 1
    ) {
      throw new FallbackProviderError(
        "INVALID_RESPONSE",
        `Fallback provider ${provider.source ?? provider.url} response is missing a valid outcome or confidence`
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
