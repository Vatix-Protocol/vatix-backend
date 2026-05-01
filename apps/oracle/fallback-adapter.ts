/**
 * Secondary Fallback Provider Adapter
 *
 * Implements the same ProviderAdapter interface as the primary adapter.
 * Used when the primary provider fails or is unavailable.
 * Preserves source attribution in the final record.
 *
 * @module apps/oracle/fallback-adapter
 */

import type {
  ProviderAdapter,
  ProviderResult,
  ResolutionRequest,
} from "./provider-adapter.js";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./timeout-utils.js";

/**
 * Fallback provider adapter configuration.
 */
export interface FallbackAdapterConfig {
  /** Base URL for the fallback provider API */
  baseUrl: string;
  /** API key for authentication */
  apiKey?: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Fallback source identifier */
  source?: string;
}

/**
 * Secondary fallback provider adapter.
 * Implements the same ProviderAdapter interface as PrimaryAdapter.
 * Used when the primary provider fails or is unavailable.
 */
export class FallbackAdapter implements ProviderAdapter {
  private readonly source: string;
  private config: FallbackAdapterConfig;

  constructor(config: FallbackAdapterConfig) {
    this.source = config.source ?? "fallback";
    this.config = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...config,
    };
  }

  /**
   * Resolve a market using the fallback provider.
   *
   * @param request - Resolution request parameters
   * @returns Provider result with source attribution
   */
  async resolve(request: ResolutionRequest): Promise<ProviderResult> {
    const timeoutMs =
      request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const timedResult = await withTimeout<ProviderResult>(
      async (signal) => {
        // Simulate fetching from fallback provider
        const response = await this.fetchFromProvider(request, signal);
        return response;
      },
      {
        timeoutMs,
        errorMessage: `Fallback provider timed out after ${timeoutMs}ms`,
      }
    );

    if (timedResult.timedOut || timedResult.error) {
      throw timedResult.error ?? new Error("Fallback provider request failed");
    }

    return timedResult.value!;
  }

  /**
   * Check if the fallback provider is healthy.
   *
   * @returns True if the provider is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      const timedResult = await withTimeout<boolean>(
        async () => {
          // In production, this would ping the provider health endpoint
          return true;
        },
        {
          timeoutMs: 5_000,
          errorMessage: "Fallback provider health check timed out",
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
   * @returns Source identifier (e.g., "fallback")
   */
  getSource(): string {
    return this.source;
  }

  /**
   * Fetch resolution data from the fallback provider.
   * Placeholder for actual HTTP request logic.
   */
  private async fetchFromProvider(
    _request: ResolutionRequest,
    _signal: AbortSignal
  ): Promise<ProviderResult> {
    // In production, this would make an HTTP request to the fallback provider API
    // For now, return a placeholder result
    return {
      outcome: true,
      confidence: 0.85,
      source: this.source,
      confidenceMetadata: {
        score: 0.85,
        method: "fallback-provider",
      },
      source: this.source,
      sourceMetadata: {
        provider: this.source,
      },
      timestamp: new Date().toISOString(),
      metadata: {
        provider: "fallback",
        marketId: _request.marketId,
      },
    };
  }
}
