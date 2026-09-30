/**
 * Primary Provider Adapter
 *
 * The default provider adapter used for market resolution.
 * Implements the ProviderAdapter interface with per-request timeout and
 * retry configuration. Retries are applied at the adapter level for
 * transient errors (network failures, 5xx responses, timeouts).
 *
 * ## Error taxonomy
 *
 * All failures surface as {@link PrimaryProviderError} carrying a stable
 * {@link PrimaryProviderErrorCode} and a coarse {@link PrimaryProviderErrorCategory}.
 * Codes are part of the public contract and must not change without a
 * versioned migration; consumers should branch on `code`, never on message
 * text. Every error also carries a `correlationId` so ops can trace a single
 * resolution attempt across logs and metrics without leaking secrets.
 *
 * @module apps/oracle/primary-adapter
 */

import type {
  ProviderAdapter,
  ProviderResult,
  ResolutionRequest,
} from "./provider-adapter.js";
import { withTimeout, DEFAULT_TIMEOUT_MS } from "./timeout-utils.js";
import {
  withRetry,
  type RetryConfig,
  DEFAULT_RETRY_CONFIG,
} from "./retry-utils.js";

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

/**
 * Coarse category for a primary provider failure.
 *
 * Categories are stable and safe to branch on for policy decisions
 * (e.g. fail-closed on writes, retry only on `TRANSIENT`).
 */
export type PrimaryProviderErrorCategory =
  | "AUTH"
  | "CLIENT"
  | "TRANSIENT"
  | "UPSTREAM"
  | "DATA";

/**
 * Stable error codes for the primary adapter.
 *
 * These codes are part of the public contract. Do not rename or remove
 * without a versioned migration; add new codes instead.
 */
export type PrimaryProviderErrorCode =
  | "PRIMARY_AUTH_FAILED"
  | "PRIMARY_NOT_FOUND"
  | "PRIMARY_RATE_LIMITED"
  | "PRIMARY_TIMEOUT"
  | "PRIMARY_UPSTREAM_ERROR"
  | "PRIMARY_INVALID_RESPONSE"
  | "PRIMARY_NETWORK_ERROR";

/**
 * @deprecated Use {@link PrimaryProviderErrorCode} for stable branching.
 * Retained for backwards compatibility with existing consumers.
 */
export type PrimaryProviderErrorType =
  | "AUTHENTICATION"
  | "INVALID_RESPONSE"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "TIMEOUT"
  | "UPSTREAM";

/**
 * Mapping from stable error code to its coarse category.
 * Single source of truth for category derivation.
 */
const ERROR_CODE_CATEGORY: Record<
  PrimaryProviderErrorCode,
  PrimaryProviderErrorCategory
> = {
  PRIMARY_AUTH_FAILED: "AUTH",
  PRIMARY_NOT_FOUND: "CLIENT",
  PRIMARY_RATE_LIMITED: "TRANSIENT",
  PRIMARY_TIMEOUT: "TRANSIENT",
  PRIMARY_UPSTREAM_ERROR: "UPSTREAM",
  PRIMARY_INVALID_RESPONSE: "DATA",
  PRIMARY_NETWORK_ERROR: "TRANSIENT",
};

/**
 * Mapping from legacy error type to stable error code.
 * Keeps the deprecated `type` field consistent with `code`.
 */
const ERROR_TYPE_TO_CODE: Record<
  PrimaryProviderErrorType,
  PrimaryProviderErrorCode
> = {
  AUTHENTICATION: "PRIMARY_AUTH_FAILED",
  NOT_FOUND: "PRIMARY_NOT_FOUND",
  RATE_LIMIT: "PRIMARY_RATE_LIMITED",
  TIMEOUT: "PRIMARY_TIMEOUT",
  UPSTREAM: "PRIMARY_UPSTREAM_ERROR",
  INVALID_RESPONSE: "PRIMARY_INVALID_RESPONSE",
};

/**
 * Typed error raised by the primary adapter.
 *
 * Carries a stable {@link PrimaryProviderErrorCode}, a coarse
 * {@link PrimaryProviderErrorCategory}, and a `correlationId` for tracing.
 * The legacy `type` field is preserved for backwards compatibility.
 */
export class PrimaryProviderError extends Error {
  /** Stable error code (public contract). */
  public readonly code: PrimaryProviderErrorCode;
  /** Coarse category derived from `code`. */
  public readonly category: PrimaryProviderErrorCategory;
  /** Correlation id for tracing this attempt across logs/metrics. */
  public readonly correlationId: string;
  /**
   * @deprecated Use `code` for stable branching.
   * Legacy error type retained for backwards compatibility.
   */
  public readonly type: PrimaryProviderErrorType;

  constructor(
    code: PrimaryProviderErrorCode,
    message: string,
    public readonly cause?: unknown,
    correlationId?: string
  ) {
    super(message);
    this.name = "PrimaryProviderError";
    this.code = code;
    this.category = ERROR_CODE_CATEGORY[code];
    this.correlationId = correlationId ?? generateCorrelationId();
    this.type = legacyTypeForCode(code);
  }

  /**
   * Serialize the error for logs/metrics without leaking secrets.
   * Never includes the underlying cause or request payload.
   */
  toJSON(): {
    name: string;
    code: PrimaryProviderErrorCode;
    category: PrimaryProviderErrorCategory;
    correlationId: string;
    message: string;
  } {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      correlationId: this.correlationId,
      message: this.message,
    };
  }
}

/**
 * Generate a correlation id for a resolution attempt.
 * Uses `crypto.randomUUID` when available, otherwise a non-secret fallback.
 */
function generateCorrelationId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `primary-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Derive the legacy error type from a stable error code.
 */
function legacyTypeForCode(
  code: PrimaryProviderErrorCode
): PrimaryProviderErrorType {
  switch (code) {
    case "PRIMARY_AUTH_FAILED":
      return "AUTHENTICATION";
    case "PRIMARY_NOT_FOUND":
      return "NOT_FOUND";
    case "PRIMARY_RATE_LIMITED":
      return "RATE_LIMIT";
    case "PRIMARY_TIMEOUT":
      return "TIMEOUT";
    case "PRIMARY_INVALID_RESPONSE":
      return "INVALID_RESPONSE";
    case "PRIMARY_UPSTREAM_ERROR":
    case "PRIMARY_NETWORK_ERROR":
    default:
      return "UPSTREAM";
  }
}

/**
 * Map a legacy error type to its stable error code.
 * Exposed for consumers migrating from `type` to `code`.
 */
export function errorCodeForType(
  type: PrimaryProviderErrorType
): PrimaryProviderErrorCode {
  return ERROR_TYPE_TO_CODE[type];
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
      retryConfig: { maxRetries: 0 },
      ...config,
    };
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
   * All failures are raised as {@link PrimaryProviderError} with a stable
   * `code`, `category`, and `correlationId`. Writes must fail closed: callers
   * should treat any thrown error as a hard failure and must not proceed with
   * settlement on a non-successful resolution.
   *
   * @param request - Resolution request parameters
   * @returns Provider result with source attribution
   */
  async resolve(request: ResolutionRequest): Promise<ProviderResult> {
    const timeoutMs =
      request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Correlation id ties every error from this attempt together for tracing.
    const correlationId = generateCorrelationId();

    // Per-request retryConfig overrides adapter-level default
    const effectiveRetryConfig: Partial<RetryConfig> = {
      ...this.config.retryConfig,
      ...(request.retryConfig ?? {}),
    };

    return withRetry(async () => {
      const timedResult = await withTimeout<ProviderResult>(
        async (signal) => this.fetchFromProvider(request, signal, correlationId),
        {
          timeoutMs,
          errorMessage: `Primary provider timed out after ${timeoutMs}ms`,
        }
      );

      if (timedResult.timedOut) {
        throw new PrimaryProviderError(
          "PRIMARY_TIMEOUT",
          timedResult.error?.message ?? "Primary provider request timed out",
          timedResult.error,
          correlationId
        );
      }

      if (timedResult.error) {
        throw this.mapProviderError(timedResult.error, correlationId);
      }

      return timedResult.value!;
    }, effectiveRetryConfig);
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
    signal: AbortSignal,
    correlationId: string
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
        correlationId
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
        "PRIMARY_INVALID_RESPONSE",
        "Primary provider response is missing a valid outcome or confidence",
        undefined,
        correlationId
      );
    }

    return {
      outcome: payload.outcome,
      confidence: payload.confidence,
      confidenceMetadata: {
        score: payload.confidence,
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

  private mapStatus(status: number): PrimaryProviderErrorCode {
    if (status === 401 || status === 403) return "PRIMARY_AUTH_FAILED";
    if (status === 404) return "PRIMARY_NOT_FOUND";
    if (status === 429) return "PRIMARY_RATE_LIMITED";
    return "PRIMARY_UPSTREAM_ERROR";
  }

  private mapProviderError(
    error: Error,
    correlationId: string
  ): PrimaryProviderError {
    if (error instanceof PrimaryProviderError) {
      return error;
    }

    if (error.name === "AbortError" || error.message.includes("timed out")) {
      return new PrimaryProviderError(
        "PRIMARY_TIMEOUT",
        error.message,
        error,
        correlationId
      );
    }

    // Network-level failures (DNS, connection refused, TLS) are transient and
    // must fail closed on writes; callers should not treat them as success.
    if (
      error.name === "TypeError" ||
      error.message.includes("fetch failed") ||
      error.message.includes("network")
    ) {
      return new PrimaryProviderError(
        "PRIMARY_NETWORK_ERROR",
        error.message,
        error,
        correlationId
      );
    }

    return new PrimaryProviderError(
      "PRIMARY_UPSTREAM_ERROR",
      error.message,
      error,
      correlationId
    );
  }
}
