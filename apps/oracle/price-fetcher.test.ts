import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PriceFetcher,
  PriceFetcherValidationError,
  AllPriceProvidersFailedError,
} from "./price-fetcher.js";

describe("PriceFetcher", () => {
  const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;

  it("throws 400 on invalid assetId", () => {
    expect(
      () => new PriceFetcher(mockLogger, { assetId: "", timeoutMs: 1000 })
    ).toThrow(PriceFetcherValidationError);
    expect(
      () =>
        new PriceFetcher(mockLogger, { assetId: 123 as any, timeoutMs: 1000 })
    ).toThrow(PriceFetcherValidationError);
  });

  it("throws 400 on invalid timeoutMs", () => {
    expect(
      () => new PriceFetcher(mockLogger, { assetId: "BTC", timeoutMs: -1 })
    ).toThrow(PriceFetcherValidationError);
    expect(
      () => new PriceFetcher(mockLogger, { assetId: "BTC", timeoutMs: 0 })
    ).toThrow(PriceFetcherValidationError);
    expect(
      () =>
        new PriceFetcher(mockLogger, {
          assetId: "BTC",
          timeoutMs: "1000" as any,
        })
    ).toThrow(PriceFetcherValidationError);
  });

  it("initializes with valid config", () => {
    expect(
      () => new PriceFetcher(mockLogger, { assetId: "BTC", timeoutMs: 1000 })
    ).not.toThrow();
  });

  describe("source attribution (#994)", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("attributes a successful fetch to the primary provider", async () => {
      const fetcher = new PriceFetcher(mockLogger, {
        assetId: "BTC",
        timeoutMs: 1000,
        primaryProvider: { name: "coingecko", fetchFn: async () => 42_000 },
      });

      const result = await fetcher.fetchPrice();

      expect(result.price).toBe(42_000);
      expect(result.source).toBe("primary");
      expect(result.sourceMetadata.provider).toBe("coingecko");
      expect(result.sourceMetadata.requestId).toBeTruthy();
      expect(result.fetchedAt).toBeTruthy();
    });

    it("attributes a fetch to the fallback provider when primary fails", async () => {
      const fetcher = new PriceFetcher(mockLogger, {
        assetId: "BTC",
        timeoutMs: 1000,
        primaryProvider: {
          name: "coingecko",
          fetchFn: async () => {
            throw new Error("primary down");
          },
        },
        fallbackProvider: { name: "pyth", fetchFn: async () => 41_500 },
      });

      const result = await fetcher.fetchPrice();

      expect(result.price).toBe(41_500);
      expect(result.source).toBe("fallback");
      expect(result.sourceMetadata.provider).toBe("pyth");
    });

    it("fails closed (throws) when every configured provider fails", async () => {
      const fetcher = new PriceFetcher(mockLogger, {
        assetId: "BTC",
        timeoutMs: 1000,
        primaryProvider: {
          name: "coingecko",
          fetchFn: async () => {
            throw new Error("primary down");
          },
        },
        fallbackProvider: {
          name: "pyth",
          fetchFn: async () => {
            throw new Error("fallback down");
          },
        },
      });

      await expect(fetcher.fetchPrice()).rejects.toBeInstanceOf(
        AllPriceProvidersFailedError
      );
    });

    it("fails closed when primary fails and no fallback is configured", async () => {
      const fetcher = new PriceFetcher(mockLogger, {
        assetId: "BTC",
        timeoutMs: 1000,
        primaryProvider: {
          name: "coingecko",
          fetchFn: async () => {
            throw new Error("primary down");
          },
        },
      });

      await expect(fetcher.fetchPrice()).rejects.toBeInstanceOf(
        AllPriceProvidersFailedError
      );
    });

    it("requires an explicit primaryProvider in production instead of using the local stub", () => {
      vi.stubEnv("NODE_ENV", "production");

      expect(
        () => new PriceFetcher(mockLogger, { assetId: "BTC", timeoutMs: 1000 })
      ).toThrow(PriceFetcherValidationError);
    });

    it("works with an explicit primaryProvider in production", async () => {
      vi.stubEnv("NODE_ENV", "production");

      const fetcher = new PriceFetcher(mockLogger, {
        assetId: "BTC",
        timeoutMs: 1000,
        primaryProvider: { name: "coingecko", fetchFn: async () => 42_000 },
      });

      const result = await fetcher.fetchPrice();
      expect(result.source).toBe("primary");
    });
  });
});
