/**
 * Provider Adapter Interface
 *
 * Defines the common interface that all provider adapters must implement.
 * Both primary and fallback adapters conform to this interface.
 *
 * @module apps/oracle/provider-adapter
 */

/**
 * Provider resolution result with source attribution.
 */
export interface ProviderResult {
  /** Resolved outcome value (true = YES, false = NO) */
  outcome: boolean;
  /** Confidence score (0-1) indicating reliability */
  confidence: number;
  /** Source identifier for attribution (e.g., "primary", "fallback-1") */
  source: string;
  /** ISO timestamp of when the data was fetched */
  timestamp: string;
  /** Optional metadata from the provider */
  metadata?: Record<string, unknown>;
}

/**
 * Parameters for a provider resolution request.
 */
export interface ResolutionRequest {
  /** Market ID to resolve */
  marketId: string;
  /** Oracle address associated with the market */
  oracleAddress: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Common interface that all provider adapters must implement.
 */
export interface ProviderAdapter {
  /**
   * Resolve a market by fetching outcome data from the provider.
   *
   * @param request - Resolution request parameters
   * @returns Promise resolving to the provider result
   */
  resolve(request: ResolutionRequest): Promise<ProviderResult>;

  /**
   * Check if this provider is healthy/available.
   *
   * @returns Promise resolving to true if the provider is healthy
   */
  healthCheck(): Promise<boolean>;

  /**
   * Get the provider name/source identifier.
   *
   * @returns Provider source identifier string
   */
  getSource(): string;
}
