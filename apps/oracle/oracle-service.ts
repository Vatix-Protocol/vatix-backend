/**
 * Oracle Service
 *
 * Orchestrates market resolution by coordinating primary and fallback providers.
 * Switches to fallback on primary failure and logs/metrics fallback usage.
 *
 * @module apps/oracle/oracle-service
 */

import type {
  ProviderAdapter,
  ProviderResult,
  ResolutionRequest,
} from "./provider-adapter.js";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./timeout-utils.js";
import { withRetry, RetryConfig } from "./retry-utils.js";

/**
 * Oracle service configuration.
 */
export interface OracleServiceConfig {
  /** Primary provider adapter */
  primaryAdapter: ProviderAdapter;
  /** Fallback provider adapter */
  fallbackAdapter: ProviderAdapter;
  /** Whether to enable fallback on primary failure */
  enableFallback?: boolean;
  /** Default timeout for resolution requests */
  defaultTimeoutMs?: number;
  /** Retry configuration for provider calls */
  retryConfig?: Partial<RetryConfig>;
}

/**
 * Metrics for tracking provider usage.
 */
export interface OracleMetrics {
  /** Number of successful primary resolutions */
  primarySuccessCount: number;
  /** Number of primary failures */
  primaryFailureCount: number;
  /** Number of fallback resolutions used */
  fallbackUsageCount: number;
  /** Number of fallback failures */
  fallbackFailureCount: number;
  /** Total resolution attempts */
  totalAttempts: number;
  /** Total retry attempts across all primary resolutions */
  retryCount: number;
}

/**
 * Oracle service for market resolution.
 * Uses primary adapter by default, switches to fallback on primary failure.
 */
export class OracleService {
  private primaryAdapter: ProviderAdapter;
  private fallbackAdapter: ProviderAdapter;
  private config: OracleServiceConfig;

  private metrics: OracleMetrics = {
    primarySuccessCount: 0,
    primaryFailureCount: 0,
    fallbackUsageCount: 0,
    fallbackFailureCount: 0,
    totalAttempts: 0,
    retryCount: 0,
  };

  constructor(config: OracleServiceConfig) {
    this.primaryAdapter = config.primaryAdapter;
    this.fallbackAdapter = config.fallbackAdapter;
    this.config = {
      enableFallback: true,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      ...config,
    };
  }

  /**
   * Resolve a market using the primary provider.
   * Falls back to the secondary provider if the primary fails.
   *
   * @param request - Resolution request parameters
   * @returns Provider result with source attribution
   * @throws Error if both primary and fallback fail
   */
  async resolve(request: ResolutionRequest): Promise<ProviderResult> {
    this.metrics.totalAttempts++;

    try {
      // Attempt primary provider
      console.log(
        `[OracleService] Resolving market ${request.marketId} using primary provider`
      );

      const result = await withRetry(
        () => this.primaryAdapter.resolve(request),
        this.config.retryConfig,
        (error, attempt, delay) => {
          this.metrics.retryCount++;
          console.warn(
            `[OracleService] Primary provider retry ${attempt} for market ${request.marketId} (delay: ${delay.toFixed(0)}ms): ${error.message}`
          );
        }
      );

      this.metrics.primarySuccessCount++;
      console.log(
        `[OracleService] Primary provider succeeded for market ${request.marketId} (source: ${result.source})`
      );
      return result;
    } catch (primaryError) {
      this.metrics.primaryFailureCount++;
      console.error(
        `[OracleService] Primary provider failed for market ${request.marketId}:`,
        primaryError instanceof Error ? primaryError.message : primaryError
      );

      // If fallback is disabled, re-throw the error
      if (!this.config.enableFallback) {
        throw primaryError;
      }

      // Attempt fallback provider
      return this.resolveWithFallback(request);
    }
  }

  /**
   * Resolve a market using the fallback provider.
   * Logs and metrics fallback usage.
   *
   * @param request - Resolution request parameters
   * @returns Provider result with source attribution
   * @throws Error if fallback also fails
   */
  private async resolveWithFallback(
    request: ResolutionRequest
  ): Promise<ProviderResult> {
    console.warn(
      `[OracleService] Falling back to secondary provider for market ${request.marketId}`
    );

    try {
      const result = await this.fallbackAdapter.resolve(request);
      this.metrics.fallbackUsageCount++;
      console.log(
        `[OracleService] Fallback provider succeeded for market ${request.marketId} (source: ${result.source})`
      );
      return result;
    } catch (fallbackError) {
      this.metrics.fallbackFailureCount++;
      console.error(
        `[OracleService] Fallback provider also failed for market ${request.marketId}:`,
        fallbackError instanceof Error ? fallbackError.message : fallbackError
      );

      throw new Error(
        `All providers failed for market ${request.marketId}. Primary: ${
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError)
        }`
      );
    }
  }

  /**
   * Check if the primary provider is healthy.
   *
   * @returns True if the primary provider is healthy
   */
  async healthCheck(): Promise<boolean> {
    try {
      return await this.primaryAdapter.healthCheck();
    } catch {
      return false;
    }
  }

  /**
   * Get current oracle metrics.
   *
   * @returns OracleMetrics snapshot
   */
  getMetrics(): OracleMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset oracle metrics.
   */
  resetMetrics(): void {
    this.metrics = {
      primarySuccessCount: 0,
      primaryFailureCount: 0,
      fallbackUsageCount: 0,
      fallbackFailureCount: 0,
      totalAttempts: 0,
      retryCount: 0,
    };
  }

  /**
   * Get the primary adapter instance.
   */
  getPrimaryAdapter(): ProviderAdapter {
    return this.primaryAdapter;
  }

  /**
   * Get the fallback adapter instance.
   */
  getFallbackAdapter(): ProviderAdapter {
    return this.fallbackAdapter;
  }
}
