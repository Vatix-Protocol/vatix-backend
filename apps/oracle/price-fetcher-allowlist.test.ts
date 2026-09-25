import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PriceFetcher,
  PriceProviderNotAllowedError,
  PriceProviderAllowlistInvalidError,
  PriceProviderInvalidPriceError,
  AllPriceProvidersFailedError,
  parseProviderAllowlist,
  PRICE_PROVIDER_ERROR_CODES,
  PRICE_PROVIDER_ALLOWLIST_ENV_VAR,
} from "./price-fetcher.js";

/**
 * Price provider allowlist (#1149).
 *
 * Deny-by-default: with an allowlist in force, an unlisted provider name is
 * rejected — at construction and again before every fetch — with a typed,
 * stable error code. Without an allowlist configured, behaviour is unchanged
 * (backwards compatible) but production logs a warning.
 */
describe("PriceFetcher provider allowlist (#1149)", () => {
  const makeLogger = () =>
    ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as any;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a provider that is on the allowlist", async () => {
    const logger = makeLogger();
    const fetcher = new PriceFetcher(logger, {
      assetId: "BTC",
      timeoutMs: 1000,
      primaryProvider: { name: "coingecko", fetchFn: async () => 42_000 },
      allowedProviders: ["coingecko"],
    });

    const result = await fetcher.fetchPrice();
    expect(result.price).toBe(42_000);
    expect(result.sourceMetadata.provider).toBe("coingecko");
  });

  it("fails closed at construction when the primary provider is not allowed", () => {
    const logger = makeLogger();

    expect(
      () =>
        new PriceFetcher(logger, {
          assetId: "BTC",
          timeoutMs: 1000,
          primaryProvider: { name: "evil-feed", fetchFn: async () => 1 },
          allowedProviders: ["coingecko", "pyth"],
        })
    ).toThrow(PriceProviderNotAllowedError);
  });

  it("fails closed at construction when the fallback provider is not allowed", () => {
    const logger = makeLogger();

    expect(
      () =>
        new PriceFetcher(logger, {
          assetId: "BTC",
          timeoutMs: 1000,
          primaryProvider: { name: "coingecko", fetchFn: async () => 1 },
          fallbackProvider: { name: "evil-feed", fetchFn: async () => 2 },
          allowedProviders: ["coingecko"],
        })
    ).toThrow(PriceProviderNotAllowedError);
  });

  it("throws a stable 403 error code and never fetches", async () => {
    const logger = makeLogger();
    const fetchFn = vi.fn(async () => 1);

    let error: PriceProviderNotAllowedError | null = null;
    try {
      new PriceFetcher(logger, {
        assetId: "BTC",
        timeoutMs: 1000,
        primaryProvider: { name: "evil-feed", fetchFn },
        allowedProviders: ["coingecko"],
      });
    } catch (err) {
      error = err as PriceProviderNotAllowedError;
    }

    expect(error).toBeInstanceOf(PriceProviderNotAllowedError);
    expect(error!.code).toBe(
      PRICE_PROVIDER_ERROR_CODES.PRICE_PROVIDER_NOT_ALLOWED
    );
    expect(error!.statusCode).toBe(403);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("re-checks the allowlist immediately before every fetch", async () => {
    const logger = makeLogger();
    const fetcher = new PriceFetcher(logger, {
      assetId: "BTC",
      timeoutMs: 1000,
      primaryProvider: { name: "coingecko", fetchFn: async () => 42_000 },
      allowedProviders: ["coingecko"],
    }) as any;

    // Simulate a provider config swapped after construction — the per-fetch
    // check must still deny it (defense in depth).
    fetcher.primaryProvider.name = "evil-feed";

    await expect(fetcher.fetchPrice()).rejects.toBeInstanceOf(
      PriceProviderNotAllowedError
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Price provider denied by allowlist",
      expect.objectContaining({ provider: "evil-feed" })
    );
  });

  it("enforces an allowlist supplied via the environment", () => {
    vi.stubEnv(PRICE_PROVIDER_ALLOWLIST_ENV_VAR, "coingecko, pyth");
    const logger = makeLogger();

    expect(
      () =>
        new PriceFetcher(logger, {
          assetId: "BTC",
          timeoutMs: 1000,
          primaryProvider: { name: "evil-feed", fetchFn: async () => 1 },
        })
    ).toThrow(PriceProviderNotAllowedError);
  });

  it("warns in production when no allowlist is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    const logger = makeLogger();

    const fetcher = new PriceFetcher(logger, {
      assetId: "BTC",
      timeoutMs: 1000,
      primaryProvider: { name: "coingecko", fetchFn: async () => 42_000 },
    });

    expect(fetcher).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("allowlist is not configured"),
      expect.anything()
    );
  });

  describe("parseProviderAllowlist", () => {
    it("returns an empty list when unset or blank", () => {
      expect(parseProviderAllowlist(undefined)).toEqual([]);
      expect(parseProviderAllowlist("")).toEqual([]);
      expect(parseProviderAllowlist("   ")).toEqual([]);
    });

    it("trims, drops blanks, and de-duplicates entries", () => {
      expect(parseProviderAllowlist(" coingecko , pyth ,,coingecko ")).toEqual([
        "coingecko",
        "pyth",
      ]);
    });

    it("fails closed when the value is non-blank but yields no entries", () => {
      expect(() => parseProviderAllowlist(",  ,")).toThrow(
        PriceProviderAllowlistInvalidError
      );
      expect(() => parseProviderAllowlist(",  ,")).toThrow(
        expect.objectContaining({
          code: PRICE_PROVIDER_ERROR_CODES.PRICE_PROVIDER_ALLOWLIST_INVALID,
        })
      );
    });

    it("never echoes the raw allowlist value in the error message", () => {
      expect(() => parseProviderAllowlist(",")).not.toThrow(/secret/i);
    });
  });

  describe("provider response validation", () => {
    it("treats a bogus primary price as a provider failure and fails over", async () => {
      const logger = makeLogger();
      const fetcher = new PriceFetcher(logger, {
        assetId: "BTC",
        timeoutMs: 1000,
        primaryProvider: { name: "coingecko", fetchFn: async () => NaN },
        fallbackProvider: { name: "pyth", fetchFn: async () => 41_500 },
      });

      const result = await fetcher.fetchPrice();
      expect(result.price).toBe(41_500);
      expect(result.source).toBe("fallback");
    });

    it("fails closed when every provider returns an invalid price", async () => {
      const logger = makeLogger();
      const fetcher = new PriceFetcher(logger, {
        assetId: "BTC",
        timeoutMs: 1000,
        primaryProvider: { name: "coingecko", fetchFn: async () => -1 },
        fallbackProvider: { name: "pyth", fetchFn: async () => 0 },
      });

      await expect(fetcher.fetchPrice()).rejects.toBeInstanceOf(
        AllPriceProvidersFailedError
      );
    });

    it("raises a typed error for a non-positive price", () => {
      const logger = makeLogger();
      const fetcher = new PriceFetcher(logger, {
        assetId: "BTC",
        timeoutMs: 1000,
        primaryProvider: { name: "coingecko", fetchFn: async () => 42_000 },
      }) as any;

      expect(() =>
        fetcher.buildResult(0, "primary", "coingecko", "req-1")
      ).toThrow(PriceProviderInvalidPriceError);
      expect(() =>
        fetcher.buildResult("123" as any, "primary", "coingecko", "req-1")
      ).toThrow(PriceProviderInvalidPriceError);
      expect(() =>
        fetcher.buildResult(Infinity, "primary", "coingecko", "req-1")
      ).toThrow(
        expect.objectContaining({
          code: PRICE_PROVIDER_ERROR_CODES.PRICE_PROVIDER_INVALID_PRICE,
        })
      );
    });
  });
});
