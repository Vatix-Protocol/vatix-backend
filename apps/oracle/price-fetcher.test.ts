import { describe, it, expect, vi, afterEach } from "vitest";
import { oraclePriceFetchAttemptsTotal } from "../../src/services/metrics.js";
import {
  PriceFetcher,
  PriceFetcherValidationError,
  AllPriceProvidersFailedError,
  PriceProviderError,
} from "./price-fetcher.js";

describe("PriceFetcher", () => {
  const mockLogger = {
    debug: () => {},
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

/**
 * #1112 — the configured `timeoutMs` is enforced.
 *
 * Before this change the timeout was validated and logged but never applied:
 * a provider that never settled pinned the sequential poll cycle forever, so
 * one hung price feed stalled resolution for every market.
 */
describe("PriceFetcher timeout enforcement (#1112)", () => {
  const mockLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("aborts a primary provider that outlives the timeout and falls back", async () => {
    vi.useFakeTimers();

    const seenSignal: AbortSignal[] = [];
    const fetcher = new PriceFetcher(mockLogger, {
      assetId: "BTC",
      timeoutMs: 1_000,
      primaryProvider: {
        name: "hung-primary",
        fetchFn: (signal) =>
          new Promise<number>((_resolve, reject) => {
            if (signal) seenSignal.push(signal);
            signal?.addEventListener("abort", () =>
              reject(new Error("aborted"))
            );
          }),
      },
      fallbackProvider: { name: "pyth", fetchFn: async () => 41_500 },
    });

    const pending = fetcher.fetchPrice();
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result.source).toBe("fallback");
    expect(result.price).toBe(41_500);
    // The hung provider is told to stop, so it can release its socket.
    expect(seenSignal[0]?.aborted).toBe(true);
  });

  it("fails closed when every provider hangs past the timeout", async () => {
    vi.useFakeTimers();

    const fetcher = new PriceFetcher(mockLogger, {
      assetId: "BTC",
      timeoutMs: 1_000,
      primaryProvider: {
        name: "hung-primary",
        fetchFn: () => new Promise<number>(() => {}),
      },
      fallbackProvider: {
        name: "hung-fallback",
        fetchFn: () => new Promise<number>(() => {}),
      },
    });

    const pending = fetcher.fetchPrice();
    const assertion = expect(pending).rejects.toBeInstanceOf(
      AllPriceProvidersFailedError
    );
    await vi.advanceTimersByTimeAsync(2_100);
    await assertion;
  });

  it("records the timeout on the emitted prometheus counter", async () => {
    // Real timers: prom-client's `get()` resolves on a real macrotask, which
    // fake timers would starve.
    const fetcher = new PriceFetcher(mockLogger, {
      assetId: "BTC",
      timeoutMs: 1_000,
      primaryProvider: {
        name: "hung-primary",
        fetchFn: () => new Promise<number>(() => {}),
      },
    });

    const before = await timeoutCountFor("hung-primary");

    await expect(fetcher.fetchPrice()).rejects.toThrow();

    expect(await timeoutCountFor("hung-primary")).toBe(before + 1);
  });

  it("surfaces the timeout reason and a correlation id on the wrapped error", async () => {
    vi.useFakeTimers();

    const fetcher = new PriceFetcher(mockLogger, {
      assetId: "BTC",
      timeoutMs: 1_000,
      primaryProvider: {
        name: "hung-primary",
        fetchFn: () => new Promise<number>(() => {}),
      },
    });

    const pending = fetcher.fetchPrice().then(
      () => null,
      (e: unknown) => e
    );
    await vi.advanceTimersByTimeAsync(1_100);
    const error = await pending;

    expect(error).toBeInstanceOf(AllPriceProvidersFailedError);
    const cause = (error as AllPriceProvidersFailedError).cause;
    expect(cause).toBeInstanceOf(PriceProviderError);
    expect((cause as PriceProviderError).reason).toBe("TIMEOUT");
    expect((cause as PriceProviderError).requestId).toBeTruthy();
  });

  it("fails closed without calling a provider when the caller has already aborted", async () => {
    const fetchFn = vi.fn().mockResolvedValue(42_000);
    const controller = new AbortController();
    controller.abort();

    const fetcher = new PriceFetcher(mockLogger, {
      assetId: "BTC",
      timeoutMs: 1_000,
      primaryProvider: { name: "coingecko", fetchFn },
    });

    await expect(
      fetcher.fetchPrice({ signal: controller.signal })
    ).rejects.toBeInstanceOf(AllPriceProvidersFailedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports ABORTED (not TIMEOUT) when the caller cancels mid-flight", async () => {
    const controller = new AbortController();
    const fetcher = new PriceFetcher(mockLogger, {
      assetId: "BTC",
      timeoutMs: 60_000,
      primaryProvider: {
        name: "slow-primary",
        fetchFn: (signal) =>
          new Promise<number>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("x")));
          }),
      },
    });

    const pending = fetcher.fetchPrice({ signal: controller.signal }).then(
      () => null,
      (e: unknown) => e as AllPriceProvidersFailedError
    );
    controller.abort();

    const error = await pending;
    const cause = error?.cause as PriceProviderError;
    expect(cause).toBeInstanceOf(PriceProviderError);
    // The timeout is 60s and it was cancelled immediately, so a TIMEOUT
    // classification here would be a lie about what happened.
    expect(cause.reason).toBe("ABORTED");
  });

  it("rejects a non-finite or non-positive price and lets the fallback answer", async () => {
    for (const badPrice of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      const fetcher = new PriceFetcher(mockLogger, {
        assetId: "BTC",
        timeoutMs: 1_000,
        primaryProvider: { name: "coingecko", fetchFn: async () => badPrice },
        fallbackProvider: { name: "pyth", fetchFn: async () => 41_500 },
      });

      const result = await fetcher.fetchPrice();
      expect(result.source).toBe("fallback");
      expect(result.price).toBe(41_500);
    }
  });

  it("fails fast in production on a timeout outside the documented policy", () => {
    vi.stubEnv("NODE_ENV", "production");

    for (const badTimeout of [500, 999_999]) {
      expect(
        () =>
          new PriceFetcher(mockLogger, {
            assetId: "BTC",
            timeoutMs: badTimeout,
            primaryProvider: { name: "coingecko", fetchFn: async () => 1 },
          })
      ).toThrow(PriceFetcherValidationError);
    }
  });
});

/** Read the current `timeout` series value for a provider from the registry. */
async function timeoutCountFor(provider: string): Promise<number> {
  const snapshot = await oraclePriceFetchAttemptsTotal.get();
  const match = snapshot.values.find(
    (v) => v.labels.provider === provider && v.labels.outcome === "timeout"
  );
  return match?.value ?? 0;
}
