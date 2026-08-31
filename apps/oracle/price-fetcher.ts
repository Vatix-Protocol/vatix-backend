import { randomUUID } from "node:crypto";
import type { ILogger } from "../../packages/shared/src/logger.js";

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
  fetchFn: () => Promise<number>;
}

export interface PriceFetcherConfig {
  assetId: string;
  timeoutMs: number;
  /** Primary price provider. Defaults to a local stub outside production. */
  primaryProvider?: PriceProviderConfig;
  /** Fallback price provider, used only if the primary fails. */
  fallbackProvider?: PriceProviderConfig;
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
  constructor(assetId: string, requestId: string, cause?: unknown) {
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
   */
  async fetchPrice(): Promise<PriceFetchResult> {
    const requestId = randomUUID();

    this.logger.info("Initiating price fetch", {
      assetId: this.config.assetId,
      timeoutMs: this.config.timeoutMs,
      requestId,
    });

    try {
      const price = await this.primaryProvider.fetchFn();
      return this.buildResult(price, "primary", this.primaryProvider.name, requestId);
    } catch (primaryError) {
      this.logger.warn("Primary price provider failed", {
        assetId: this.config.assetId,
        requestId,
        provider: this.primaryProvider.name,
        error:
          primaryError instanceof Error
            ? primaryError.message
            : String(primaryError),
      });

      if (!this.fallbackProvider) {
        this.logger.error("Price fetch failed — no fallback configured", {
          assetId: this.config.assetId,
          requestId,
        });
        throw new AllPriceProvidersFailedError(
          this.config.assetId,
          requestId,
          primaryError
        );
      }

      try {
        const price = await this.fallbackProvider.fetchFn();
        this.logger.warn("Price resolved via fallback provider", {
          assetId: this.config.assetId,
          requestId,
          provider: this.fallbackProvider.name,
        });
        return this.buildResult(
          price,
          "fallback",
          this.fallbackProvider.name,
          requestId
        );
      } catch (fallbackError) {
        this.logger.error("All price providers failed", {
          assetId: this.config.assetId,
          requestId,
          error:
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError),
        });
        throw new AllPriceProvidersFailedError(
          this.config.assetId,
          requestId,
          fallbackError
        );
      }
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
