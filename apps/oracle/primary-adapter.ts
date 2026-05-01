/**
 * Primary Provider Adapter
 *
 * The default provider adapter used for market resolution.
 * Implements the ProviderAdapter interface.
 *
 * @module apps/oracle/primary-adapter
 */

import type {
  ProviderAdapter,
  ProviderResult,
  ResolutionRequest,
} from "./provider-adapter.js";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./timeout-utils.js";

/**
 * Primary provider adapter configuration.
 */
export interface PrimaryAdapterConfig {
  /** Base URL for the primary provider API */
  baseUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
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

export class PrimaryProviderError extends Error {
  constructor(
    public readonly type: PrimaryProviderErrorType,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "PrimaryProviderError";
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
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...config,
    };
    this.fetchFn = config.fetchFn ?? fetch;
  }

  /**
   * Resolve a market using the primary provider.
   *
   * @param request - Resolution request parameters
   * @returns Provider result with source attribution
   */
  async resolve(request: ResolutionRequest): Promise<ProviderResult> {
    const timeoutMs =
      request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const timedResult = await withTimeout<ProviderResult>(
      async (signal) => {
        // Simulate fetching from primary provider
        // In production, this would make an HTTP request to the provider API
        const response = await this.fetchFromProvider(request, signal);
        return response;
      },
      {
        timeoutMs,
        errorMessage: `Primary provider timed out after ${timeoutMs}ms`,
      }
    );

    if (timedResult.timedOut || timedResult.error) {
      throw timedResult.error ?? new Error("Primary provider request failed");
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
  }

  /**
   * Check if the primary provider is healthy.
   *
   * @returns True if the provider is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const timedResult = await withTimeout<boolean>(
        async () => {
          // In production, this would ping the provider health endpoint
          return true;
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
    _request: ResolutionRequest,
    _signal: AbortSignal
  ): Promise<ProviderResult> {
    // In production, this would make an HTTP request to the provider API
    // For now, return a placeholder result
    return {
      outcome: true,
      confidence: 0.95,
      source: this.source,
      timestamp: new Date().toISOString(),
      metadata: {
        provider: "primary",
        marketId: _request.marketId,
      },
    };
  }
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
        `Primary provider returned HTTP ${response.status}`
      );
    }

    const payload = (await response.json()) as Partial<PrimaryProviderResponse>;
    if (
      typeof payload.outcome !== "boolean" ||
      typeof payload.confidence !== "number" ||
      payload.confidence < 0 ||
      payload.confidence > 1
    ) {
      throw new PrimaryProviderError(
        "INVALID_RESPONSE",
        "Primary provider response is missing a valid outcome or confidence"
      );
    }

    return {
      outcome: true,
      confidence: 0.95,
      confidenceMetadata: {
        score: 0.95,
        method: "primary-provider",
      },
      source: this.source,
      sourceMetadata: {
        provider: this.source,
      },
      timestamp: new Date().toISOString(),
      metadata: {
        provider: "primary",
        marketId: request.marketId,
        ...payload.metadata,
      },
    };
  }

  private getHeaders(): HeadersInit {
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
