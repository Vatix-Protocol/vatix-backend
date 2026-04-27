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
}

/**
 * Primary provider adapter.
 * This is the default adapter used for market resolution.
 */
export class PrimaryAdapter implements ProviderAdapter {
  private readonly source = "primary";
  private config: PrimaryAdapterConfig;

  constructor(config: PrimaryAdapterConfig) {
    this.config = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      ...config,
    };
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
}
