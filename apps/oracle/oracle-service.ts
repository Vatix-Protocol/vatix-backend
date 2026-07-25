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
import { DEFAULT_TIMEOUT_MS } from "./timeout-utils.js";
import { withRetry, RetryConfig, isRetryableError } from "./retry-utils.js";
import type { ILogger } from "../../packages/shared/src/logger.js";
import type { SubmissionQueueItem } from "./submission-queue.js";
import { SubmissionQueue } from "./submission-queue.js";

/**
 * Callback invoked when a resolution succeeds and should be enqueued.
 */
export type EnqueueCallback = (item: SubmissionQueueItem) => Promise<void>;

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
  /** Structured logger — defaults to a no-op logger if omitted */
  logger?: ILogger;
  /** Optional submission queue for enqueuing resolved reports */
  submissionQueue?: SubmissionQueue;
  /** Optional enqueue callback (alternative to submissionQueue) */
  enqueueCallback?: EnqueueCallback;
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
 * Optionally enqueues successful resolutions for on-chain submission.
 *
 * ## Failover policy
 *
 * 1. The primary adapter is called first, with up to `retryConfig.maxRetries`
 *    retries using exponential back-off (see retry-utils.ts).
 * 2. If the primary fails with a **retryable** (transient) error after all
 *    retries, and `enableFallback` is true, the fallback adapter is tried once.
 *    Retryable errors: network failures, 5xx responses, timeouts.
 *    Non-retryable errors (4xx client errors, invalid responses) skip
 *    the fallback and are re-thrown immediately.
 * 3. If the fallback adapter also fails, an error is thrown that aggregates
 *    both failure messages.
 * 4. Both adapters enqueue a successful resolution via `submissionQueue` or
 *    `enqueueCallback` when configured.
 */
export class OracleService {
  private primaryAdapter: ProviderAdapter;
  private fallbackAdapter: ProviderAdapter;
  private config: OracleServiceConfig;
  private readonly logger: ILogger;
  private submissionQueue?: SubmissionQueue;
  private enqueueCallback?: EnqueueCallback;

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
    const noOpLogger: ILogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => noOpLogger,
    };
    this.logger = config.logger ?? noOpLogger;
    this.submissionQueue = config.submissionQueue;
    this.enqueueCallback = config.enqueueCallback;
    this.config = {
      enableFallback: true,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      retryConfig: { maxRetries: 0 },
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
      this.logger.info("Resolving market via primary provider", {
        marketId: request.marketId,
      });

      const result = await withRetry(
        () => this.primaryAdapter.resolve(request),
        this.config.retryConfig,
        (error, attempt, delay) => {
          this.metrics.retryCount++;
          this.logger.warn("Primary provider retry", {
            marketId: request.marketId,
            attempt,
            delayMs: Math.round(delay),
            error: error.message,
          });
        }
      );

      this.metrics.primarySuccessCount++;
      this.logger.info("Primary provider resolved market", {
        marketId: request.marketId,
        source: result.source,
      });

      // Enqueue for on-chain submission if configured
      await this.enqueueResult(request, result);

      return result;
    } catch (primaryError) {
      this.metrics.primaryFailureCount++;
      this.logger.error("Primary provider failed", {
        marketId: request.marketId,
        error:
          primaryError instanceof Error
            ? primaryError.message
            : String(primaryError),
      });

      // If fallback is disabled, re-throw the error
      if (!this.config.enableFallback) {
        throw primaryError;
      }

      // Only fall back on retryable (transient) errors
      if (!isRetryableError(primaryError)) {
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
    this.logger.warn("Falling back to secondary provider", {
      marketId: request.marketId,
    });

    try {
      const result = await this.fallbackAdapter.resolve(request);
      this.metrics.fallbackUsageCount++;
      this.logger.info("Fallback provider resolved market", {
        marketId: request.marketId,
        source: result.source,
      });

      // Enqueue for on-chain submission if configured
      await this.enqueueResult(request, result);

      return result;
    } catch (fallbackError) {
      this.metrics.fallbackFailureCount++;
      this.logger.error("Fallback provider failed", {
        marketId: request.marketId,
        error:
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError),
      });

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

  /**
   * Enqueue a resolved result for on-chain submission.
   * Skips if no queue or callback is configured.
   */
  private async enqueueResult(
    request: ResolutionRequest,
    result: ProviderResult
  ): Promise<void> {
    if (!this.submissionQueue && !this.enqueueCallback) {
      return;
    }

    try {
      const item: SubmissionQueueItem = {
        id: `${request.marketId}-${Date.now()}`,
        request,
        result,
        status: "pending",
        enqueuedAt: new Date().toISOString(),
        attempts: 0,
      };

      if (this.enqueueCallback) {
        await this.enqueueCallback(item);
      } else if (this.submissionQueue) {
        this.submissionQueue.enqueue(item);
      }
    } catch (error) {
      this.logger.error("Failed to enqueue resolution for submission", {
        marketId: request.marketId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
