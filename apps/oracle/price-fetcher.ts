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
  /**
   * Allowlist of permitted provider names (#1149). Deny-by-default: when a
   * non-empty allowlist is in force, any primary/fallback provider whose
   * `name` is not listed is rejected with `PriceProviderNotAllowedError` —
   * at construction time and again immediately before each fetch.
   *
   * When omitted, the `ORACLE_PRICE_PROVIDER_ALLOWLIST` environment variable
   * is consulted. An explicitly-passed empty array means "deny every provider"
   * (fail closed).
   */
  allowedProviders?: string[];
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

/**
 * Stable, machine-readable error codes for the price-provider allowlist and
 * provider-response validation (#1149). Callers/dashboards branch on `code`;
 * free-form messages are never parsed.
 */
export const PRICE_PROVIDER_ERROR_CODES = {
  /** The provider is not on the configured allowlist — deny, fail closed. */
  PRICE_PROVIDER_NOT_ALLOWED: "PRICE_PROVIDER_NOT_ALLOWED",
  /** The allowlist itself was configured but contained no usable entry. */
  PRICE_PROVIDER_ALLOWLIST_INVALID: "PRICE_PROVIDER_ALLOWLIST_INVALID",
  /** The provider returned a non-finite or non-positive price. */
  PRICE_PROVIDER_INVALID_PRICE: "PRICE_PROVIDER_INVALID_PRICE",
} as const;

export type PriceProviderErrorCode =
  (typeof PRICE_PROVIDER_ERROR_CODES)[keyof typeof PRICE_PROVIDER_ERROR_CODES];

/** Comma-separated allowlist of permitted price-provider names. */
export const PRICE_PROVIDER_ALLOWLIST_ENV_VAR =
  "ORACLE_PRICE_PROVIDER_ALLOWLIST";

/** Provider tier, used for attribution and allowlist error messages. */
export type PriceProviderTier = "primary" | "fallback";

/**
 * Thrown when a price provider is used that is not on the configured
 * allowlist. Deny-by-default: this is a fail-closed condition — no price is
 * fetched or returned, so an unauthorised/manipulated provider can never
 * influence a resolution.
 */
export class PriceProviderNotAllowedError extends Error {
  readonly code = PRICE_PROVIDER_ERROR_CODES.PRICE_PROVIDER_NOT_ALLOWED;
  /** 403: authenticated caller, disallowed provider policy. */
  readonly statusCode = 403;

  constructor(
    readonly provider: string,
    readonly tier: PriceProviderTier,
    readonly requestId: string
  ) {
    super(
      `Price provider "${provider}" is not on the allowlist (tier=${tier}, requestId=${requestId})`
    );
    this.name = "PriceProviderNotAllowedError";
  }
}

/**
 * Thrown when the allowlist was explicitly configured but contained no usable
 * (non-blank) entry. Treated as a misconfiguration and fails closed rather
 * than silently disabling the policy.
 */
export class PriceProviderAllowlistInvalidError extends Error {
  readonly code = PRICE_PROVIDER_ERROR_CODES.PRICE_PROVIDER_ALLOWLIST_INVALID;
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = "PriceProviderAllowlistInvalidError";
  }
}

/**
 * Thrown when a provider returns a non-finite, non-numeric, zero, or negative
 * price. Treated as a provider failure so the caller can fail over (and, if no
 * provider succeeds, fail closed) instead of persisting a bogus price.
 */
export class PriceProviderInvalidPriceError extends Error {
  readonly code = PRICE_PROVIDER_ERROR_CODES.PRICE_PROVIDER_INVALID_PRICE;
  readonly statusCode = 502;

  constructor(
    readonly provider: string,
    readonly tier: PriceProviderTier,
    readonly requestId: string
  ) {
    super(
      `Price provider "${provider}" returned an invalid price (tier=${tier}, requestId=${requestId})`
    );
    this.name = "PriceProviderInvalidPriceError";
  }
}

/**
 * Parse a comma-separated provider allowlist.
 *
 * - `undefined` / blank input → `[]` (no allowlist configured).
 * - Non-blank input with only blank entries → throws
 *   `PriceProviderAllowlistInvalidError` (fail closed: a broken allowlist
 *   must never silently disable the policy).
 *
 * The raw value is never echoed in the error message, so an accidentally
 * pasted secret cannot leak through logs.
 */
export function parseProviderAllowlist(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }

  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (entries.length === 0) {
    throw new PriceProviderAllowlistInvalidError(
      `${PRICE_PROVIDER_ALLOWLIST_ENV_VAR} was set but contained no usable provider names`
    );
  }

  // De-duplicate while preserving operator-supplied order for stable logs.
  return [...new Set(entries)];
}

/**
 * Merge an explicit config allowlist with the environment allowlist.
 * An explicit config list wins when both are present; the environment is the
 * operator-facing switch (see .env.example).
 */
function resolveProviderAllowlist(
  configAllowlist: string[] | undefined,
  envAllowlist: string | undefined
): string[] {
  if (configAllowlist !== undefined) {
    return parseProviderAllowlist(configAllowlist.join(","));
  }
  return parseProviderAllowlist(envAllowlist);
}

const DEFAULT_STUB_PRICE = 100.5;

export class PriceFetcher {
  private readonly primaryProvider: PriceProviderConfig;
  private readonly fallbackProvider?: PriceProviderConfig;
  /**
   * Allowlist of permitted provider names (#1149). Empty means "no allowlist
   * configured" — documented as not recommended for production.
   */
  private readonly allowedProviders: readonly string[];

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

    // Allowlist is resolved and enforced at construction time so a
    // misconfigured deploy fails fast rather than quietly serving prices from
    // an unapproved feed (#1149).
    this.allowedProviders = resolveProviderAllowlist(
      config.allowedProviders,
      process.env[PRICE_PROVIDER_ALLOWLIST_ENV_VAR]
    );

    if (this.allowedProviders.length === 0) {
      if (isProduction) {
        // Loud but non-fatal: hard-failing would break existing production
        // deploys on upgrade, and the docs/SECURITY guidance is to pin
        // providers. Operators get an alertable warning instead.
        this.logger.warn(
          "Price provider allowlist is not configured — every provider name is currently accepted. " +
            `Set ${PRICE_PROVIDER_ALLOWLIST_ENV_VAR} to enforce deny-by-default (#1149).`,
          { assetId: this.config.assetId }
        );
      }
    } else {
      this.assertProviderAllowed(
        this.primaryProvider.name,
        "primary",
        "startup"
      );
      if (this.fallbackProvider) {
        this.assertProviderAllowed(
          this.fallbackProvider.name,
          "fallback",
          "startup"
        );
      }
    }
  }

  /**
   * Enforce the provider allowlist. Deny-by-default when an allowlist is in
   * force: any provider not explicitly listed is rejected with a typed
   * `PriceProviderNotAllowedError` and no fetch is attempted. The check is
   * repeated before every fetch as defense in depth (a provider config must
   * not be able to swap in an unapproved feed after construction).
   *
   * @throws {PriceProviderNotAllowedError} When the provider is not allowed.
   */
  assertProviderAllowed(
    provider: string,
    tier: PriceProviderTier,
    requestId: string
  ): void {
    if (this.allowedProviders.length === 0) {
      return;
    }

    if (!this.allowedProviders.includes(provider)) {
      this.logger.warn("Price provider denied by allowlist", {
        assetId: this.config.assetId,
        provider,
        tier,
        requestId,
        allowedProviderCount: this.allowedProviders.length,
      });
      throw new PriceProviderNotAllowedError(provider, tier, requestId);
    }
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
      allowlistEnforced: this.allowedProviders.length > 0,
    });

    // Deny-by-default, re-checked per fetch (#1149).
    this.assertProviderAllowed(this.primaryProvider.name, "primary", requestId);

    try {
      const price = await this.primaryProvider.fetchFn();
      return this.buildResult(
        price,
        "primary",
        this.primaryProvider.name,
        requestId
      );
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
        this.assertProviderAllowed(
          this.fallbackProvider.name,
          "fallback",
          requestId
        );
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
    // Adversarial / faulty-provider guard (#1149): a non-finite, zero, or
    // negative price must never be reported as a successful fetch — it is
    // treated as a provider failure so fail-over (and ultimately fail-closed)
    // semantics apply instead of persisting a bogus price.
    this.assertValidPrice(price, source, provider, requestId);

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

  /**
   * Reject non-finite, non-numeric, zero, and negative prices with a typed
   * `PriceProviderInvalidPriceError` (#1149). The error is raised inside the
   * primary/fallback try blocks, so a bogus price is treated exactly like a
   * provider outage: fail over, and if no provider produces a sane price,
   * fail closed with `AllPriceProvidersFailedError`.
   */
  private assertValidPrice(
    price: number,
    source: PriceSource,
    provider: string,
    requestId: string
  ): void {
    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
      this.logger.warn("Price provider returned an invalid price", {
        assetId: this.config.assetId,
        requestId,
        source,
        provider,
        // Only the *type* of the bad value is logged — a hostile or buggy
        // provider must not be able to inject arbitrary text into our logs.
        priceType: typeof price,
        priceFinite: typeof price === "number" && Number.isFinite(price),
      });
      throw new PriceProviderInvalidPriceError(provider, source, requestId);
    }
  }
}
