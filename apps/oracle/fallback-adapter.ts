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
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./timeout-utils.js";
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
 * Secondary fallback provider adapter.
 * Walks the provider chain in order, returning the first successful result.
 */
export class FallbackAdapter implements ProviderAdapter {
  private readonly config: FallbackAdapterConfig;
  private readonly fetchFn: typeof fetch;

  constructor(config: FallbackAdapterConfig) {
    if (!config.providers || config.providers.length === 0) {
      throw new Error("FallbackAdapter requires at least one provider");
    }
    this.config = { timeoutMs: DEFAULT_TIMEOUT_MS, ...config };
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Resolve a market by walking the provider chain.
   * Each provider is retried per retryConfig before advancing.
   */
  async resolve(request: ResolutionRequest): Promise<ProviderResult> {
    const timeoutMs =
      request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
