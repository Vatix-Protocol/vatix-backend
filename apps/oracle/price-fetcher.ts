import { randomUUID } from "node:crypto";
import type { ILogger } from "../../packages/shared/src/logger.js";
import { oraclePriceFetchAttemptsTotal } from "../../src/services/metrics.js";
import { validateTimeout } from "./timeout-utils.js";

/**
 * Stable, machine-readable failure reasons for a single provider attempt.
 * These strings are part of the module's contract: callers and dashboards
 * branch on them, so they must not be reworded casually.
 */
export type PriceFetchFailureReason =
  "TIMEOUT" | "ABORTED" | "INVALID_PRICE" | "PROVIDER_ERROR";

/**
 * Error raised for a single provider attempt that did not produce a usable
 * price. Carries the reason code plus the per-fetch correlation id so a
 * timeout on the primary can be traced end-to-end across the fallback attempt
 * and the final fail-closed error.
 */
export class PriceProviderError extends Error {
  constructor(
    public readonly reason: PriceFetchFailureReason,
    message: string,
    public readonly requestId: string,
    public readonly provider: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "PriceProviderError";
  }
}

/**
 * Which provider actually produced a price. Persisted onto
 * `OracleReport.source` (via callers) so forensics can distinguish a
 * primary-provider price from a fallback-provider price after the fact
 * (#994) — without this, an operator investigating a bad resolution cannot
 * tell whether the price came from the trusted primary feed or a
 * lower-confidence fallback.
 */
export type PriceSource = "primary" | "fallback";

/**
 * A single upstream price provider: a name for attribution/logging and the
 * function that fetches the price.
 */
export interface PriceProviderConfig {
  /** Attribution label, e.g. "coingecko", "pyth". Never a secret. */
  name: string;
  /**
   * Fetches the price. The optional `signal` aborts when the configured
   * timeout elapses or the caller cancels, so a provider built on `fetch` can
   * release the socket instead of leaking a hung request. Providers that
   * ignore it are still bounded — the caller races the promise against the
   * deadline — but they cannot free the underlying connection.
   */
  fetchFn: (signal?: AbortSignal) => Promise<number>;
}

export interface PriceFetcherConfig {
  assetId: string;
  /**
   * Hard per-provider timeout in milliseconds. Previously this value was
   * validated and logged but never enforced, so a hung provider pinned the
   * oracle poll cycle indefinitely — the poll loop is sequential, so one
   * hanging provider stalled resolution for *every* market. Each provider
   * attempt is now raced against this deadline.
   */
  timeoutMs: number;
  /** Primary price provider. Defaults to a local stub outside production. */
  primaryProvider?: PriceProviderConfig;
  /** Fallback price provider, used only if the primary fails. */
  fallbackProvider?: PriceProviderConfig;
}

/** Optional per-call overrides for {@link PriceFetcher.fetchPrice}. */
export interface PriceFetchOptions {
  /**
   * Caller-owned cancellation signal (e.g. the poll loop's shutdown signal).
   * Aborting it fails the in-flight fetch closed rather than letting it
   * resolve a price after shutdown.
   */
  signal?: AbortSignal;
}

/**
 * Result of a price fetch, always carrying source attribution.
 */
export interface PriceFetchResult {
  price: number;
  /** Which provider tier produced this price: "primary" or "fallback". */
  source: PriceSource;
  /** Attribution metadata — provider name and correlation id for forensics. */
  sourceMetadata: {
    provider: string;
    requestId: string;
  };
  fetchedAt: string;
}

export class PriceFetcherValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "PriceFetcherValidationError";
  }
}

/**
 * Thrown when both the primary and fallback price providers fail. Fails
 * closed: no stale/default price is ever returned in place of a real one.
 */
export class AllPriceProvidersFailedError extends Error {
  constructor(
    assetId: string,
    requestId: string,
    /** The last provider failure — a `PriceProviderError` carrying the reason code. */
    public readonly cause?: unknown
  ) {
    super(
      `All price providers failed for asset ${assetId} (requestId=${requestId}): ${
        cause instanceof Error ? cause.message : String(cause)
      }`
    );
    this.name = "AllPriceProvidersFailedError";
  }
}

const DEFAULT_STUB_PRICE = 100.5;

export class PriceFetcher {
  private readonly primaryProvider: PriceProviderConfig;
  private readonly fallbackProvider?: PriceProviderConfig;
  /** Validated per-provider deadline, in milliseconds. */
  private readonly timeoutMs: number;

  constructor(
    private readonly logger: ILogger,
    private readonly config: PriceFetcherConfig
  ) {
    if (!config.assetId || typeof config.assetId !== "string") {
      throw new PriceFetcherValidationError(
        "Invalid assetId: must be a non-empty string"
      );
    }
    if (
      typeof config.timeoutMs !== "number" ||
      config.timeoutMs <= 0 ||
      isNaN(config.timeoutMs)
    ) {
      throw new PriceFetcherValidationError(
        "Invalid timeoutMs: must be a positive number"
      );
    }

    // Route the timeout through the shared policy validator so a value that
    // the documented policy does not allow fails fast in production instead of
    // running with a silently clamped deadline (#1112). The error is re-typed
    // so callers keep seeing a single validation type for this constructor.
    try {
      this.timeoutMs = validateTimeout(config.timeoutMs);
    } catch (error) {
      throw new PriceFetcherValidationError(
        error instanceof Error ? error.message : String(error)
      );
    }

    const isProduction = process.env.NODE_ENV === "production";

    if (config.primaryProvider) {
      this.primaryProvider = config.primaryProvider;
    } else if (isProduction) {
      // Never silently stub a real price feed in production — fail fast at
      // construction time instead of returning a fake price later.
      throw new PriceFetcherValidationError(
        "primaryProvider is required in NODE_ENV=production — no local stub is used"
      );
    } else {
      this.primaryProvider = {
        name: "local-stub-primary",
        fetchFn: async () => DEFAULT_STUB_PRICE,
      };
    }

    this.fallbackProvider = config.fallbackProvider;
  }

  /**
   * Fetch the current price for the configured asset, with explicit source
   * attribution. Tries the primary provider first; on failure, falls back
   * to the fallback provider if one is configured. If every configured
   * provider fails, throws `AllPriceProvidersFailedError` — no default or
   * stale price is ever silently returned.
   *
   * Each attempt is bounded by the configured `timeoutMs` and aborted when
   * the caller's `signal` fires, so a hung provider can no longer stall the
   * (sequential) poll cycle for every market.
   */
  async fetchPrice(options: PriceFetchOptions = {}): Promise<PriceFetchResult> {
    const requestId = randomUUID();
    const { signal } = options;

    this.logger.info("Initiating price fetch", {
      assetId: this.config.assetId,
      timeoutMs: this.timeoutMs,
      requestId,
    });

    // A caller that is already shutting down must not start new work.
    if (signal?.aborted) {
      throw new AllPriceProvidersFailedError(
        this.config.assetId,
        requestId,
        new PriceProviderError(
          "ABORTED",
          "Price fetch aborted before the first provider attempt",
          requestId,
          this.primaryProvider.name
        )
      );
    }

    const primary = await this.attemptProvider(
      this.primaryProvider,
      "primary",
      requestId,
      signal
    );

    if (typeof primary === "number") {
      return this.buildResult(
        primary,
        "primary",
        this.primaryProvider.name,
        requestId
      );
    }

    if (!this.fallbackProvider) {
      this.logger.error("Price fetch failed — no fallback configured", {
        event: "oracle.price_fetch_fail_closed",
        assetId: this.config.assetId,
        requestId,
        reason: primary.reason,
      });
      throw new AllPriceProvidersFailedError(
        this.config.assetId,
        requestId,
        primary
      );
    }

    const fallback = await this.attemptProvider(
      this.fallbackProvider,
      "fallback",
      requestId,
      signal
    );

    if (typeof fallback === "number") {
      this.logger.warn("Price resolved via fallback provider", {
        assetId: this.config.assetId,
        requestId,
        provider: this.fallbackProvider.name,
      });
      return this.buildResult(
        fallback,
        "fallback",
        this.fallbackProvider.name,
        requestId
      );
    }

    this.logger.error("All price providers failed", {
      event: "oracle.price_fetch_fail_closed",
      assetId: this.config.assetId,
      requestId,
      primaryReason: primary.reason,
      fallbackReason: fallback.reason,
      error: fallback.message,
    });
    throw new AllPriceProvidersFailedError(
      this.config.assetId,
      requestId,
      fallback
    );
  }

  /**
   * Run a single bounded provider attempt.
   *
   * @returns the validated price on success, or a `PriceProviderError` on
   *   failure. Never throws for a provider-level problem — the caller decides
   *   whether to try the fallback or fail closed.
   */
  private async attemptProvider(
    provider: PriceProviderConfig,
    tier: PriceSource,
    requestId: string,
    signal?: AbortSignal
  ): Promise<number | PriceProviderError> {
    const controller = new AbortController();
    const onCallerAbort = () =>
      controller.abort(
        signal?.reason ?? new Error("Price fetch cancelled by caller")
      );

    if (signal) {
      if (signal.aborted) {
        onCallerAbort();
      } else {
        signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new Error(
          `Price provider ${provider.name} timed out after ${this.timeoutMs}ms`
        )
      );
    }, this.timeoutMs);
    // A price deadline must never be the reason the process stays alive.
    timer.unref?.();

    const startTime = performance.now();

    try {
      const price = await Promise.race([
        provider.fetchFn(controller.signal),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () =>
              reject(
                controller.signal.reason instanceof Error
                  ? controller.signal.reason
                  : new Error("Price fetch aborted")
              ),
            { once: true }
          );
        }),
      ]);

      this.assertValidPrice(price, provider, requestId);
      oraclePriceFetchAttemptsTotal.labels(provider.name, "success").inc();
      this.logger.debug("Price provider attempt succeeded", {
        assetId: this.config.assetId,
        requestId,
        provider: provider.name,
        tier,
        durationMs: Math.round(performance.now() - startTime),
      });
      return price;
    } catch (error) {
      const abortedByCaller = !timedOut && signal?.aborted === true;
      const reason: PriceFetchFailureReason = abortedByCaller
        ? "ABORTED"
        : timedOut
          ? "TIMEOUT"
          : error instanceof PriceProviderError
            ? error.reason
            : "PROVIDER_ERROR";

      // Label values are lowercase and part of the metric contract
      // (`success` | `failure` | `timeout`) — dashboards and alerts match on
      // them exactly. `aborted` is reported as `failure`: it is caller-driven
      // cancellation, not a provider fault, and folding it into `timeout` would
      // make a shutdown look like an upstream outage.
      const metricOutcome = reason === "TIMEOUT" ? "timeout" : "failure";

      oraclePriceFetchAttemptsTotal.labels(provider.name, metricOutcome).inc();

      this.logger.warn("Price provider attempt failed", {
        event: "oracle.price_provider_attempt_failed",
        assetId: this.config.assetId,
        requestId,
        provider: provider.name,
        tier,
        reason,
        durationMs: Math.round(performance.now() - startTime),
        error: error instanceof Error ? error.message : String(error),
      });

      return new PriceProviderError(
        reason,
        `Price provider ${provider.name} failed (${reason}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        requestId,
        provider.name,
        error
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /**
   * Reject prices that cannot be used for settlement. A `NaN`, infinite, or
   * non-positive price is a provider fault, not a usable value — passing it on
   * would poison every downstream calculation, so the attempt fails closed and
   * the fallback provider gets a chance to answer instead.
   */
  private assertValidPrice(
    price: number,
    provider: PriceProviderConfig,
    requestId: string
  ): void {
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      throw new PriceProviderError(
        "INVALID_PRICE",
        `Price provider ${provider.name} returned an unusable price`,
        requestId,
        provider.name
      );
    }
  }

  private buildResult(
    price: number,
    source: PriceSource,
    provider: string,
    requestId: string
  ): PriceFetchResult {
    const result: PriceFetchResult = {
      price,
      source,
      sourceMetadata: { provider, requestId },
      fetchedAt: new Date().toISOString(),
    };

    this.logger.info("Price fetch successful", {
      assetId: this.config.assetId,
      requestId,
      source,
      provider,
      price,
    });

    return result;
  }
}
