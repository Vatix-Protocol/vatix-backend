import { describe, expect, it, vi, afterEach } from "vitest";
import {
  FallbackAdapter,
  FallbackProviderError,
  providerLabel,
  MAX_FALLBACK_PROVIDERS,
} from "./fallback-adapter.js";
import type { FallbackAdapterConfig } from "./fallback-adapter.js";
import { oracleFallbackChainAttemptsTotal } from "../../src/services/metrics.js";

const PROVIDER_URL = "https://fallback.example.com";

function makeAdapter(overrides: Partial<FallbackAdapterConfig> = {}) {
  return new FallbackAdapter({
    providers: [
      { url: PROVIDER_URL, source: "fallback-1", apiKey: "test-key" },
    ],
    ...overrides,
  } as FallbackAdapterConfig);
}

function okResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("FallbackAdapter", () => {
  it("maps a valid provider response to a ProviderResult", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      okResponse({
        outcome: true,
        confidence: 0.85,
        timestamp: "2026-01-01T00:00:00.000Z",
        metadata: { providerRequestId: "req-42" },
      })
    );
    const adapter = makeAdapter({
      providers: [
        { url: PROVIDER_URL, source: "fallback-1", apiKey: "test-key" },
      ],
      fetchFn,
    });

    const result = await adapter.resolve({
      marketId: "market-1",
      oracleAddress: "GORACLE",
    });

    expect(result).toMatchObject({
      outcome: true,
      confidence: 0.85,
      source: "fallback-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      confidenceMetadata: { score: 0.85, method: "fallback-provider" },
      sourceMetadata: { provider: "fallback-1" },
      metadata: {
        provider: "fallback-1",
        marketId: "market-1",
        providerRequestId: "req-42",
      },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      new URL(
        `${PROVIDER_URL}/resolve?marketId=market-1&oracleAddress=GORACLE`
      ),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      })
    );
  });

  it("maps HTTP errors to typed FallbackProviderError", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("rate limited", { status: 429 }));
    const adapter = makeAdapter({
      providers: [{ url: PROVIDER_URL }],
      retryConfig: { maxRetries: 0 },
      fetchFn,
    });

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toMatchObject({
      name: "FallbackProviderError",
      type: "ALL_PROVIDERS_FAILED",
    } satisfies Partial<FallbackProviderError>);
  });

  it("throws INVALID_RESPONSE when outcome or confidence is missing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ outcome: true })); // missing confidence
    const adapter = makeAdapter({
      providers: [{ url: PROVIDER_URL }],
      fetchFn,
      retryConfig: { maxRetries: 0 },
    });

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toMatchObject({
      name: "FallbackProviderError",
      type: "ALL_PROVIDERS_FAILED",
    });
  });

  it("advances to the next provider when the first fails", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(okResponse({ outcome: false, confidence: 0.72 }));

    const adapter = new FallbackAdapter({
      providers: [
        { url: "https://fallback-a.example.com", source: "fallback-1" },
        { url: "https://fallback-b.example.com", source: "fallback-2" },
      ],
      retryConfig: { maxRetries: 0 },
      fetchFn,
    });

    const result = await adapter.resolve({
      marketId: "market-1",
      oracleAddress: "GORACLE",
    });

    expect(result.outcome).toBe(false);
    expect(result.confidence).toBe(0.72);
    expect(result.source).toBe("fallback-2");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("throws ALL_PROVIDERS_FAILED when every provider in the chain fails", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("service unavailable", { status: 503 }));

    const adapter = new FallbackAdapter({
      providers: [
        { url: "https://fallback-a.example.com", source: "fallback-1" },
        { url: "https://fallback-b.example.com", source: "fallback-2" },
      ],
      retryConfig: { maxRetries: 0 },
      fetchFn,
    });

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toMatchObject({
      name: "FallbackProviderError",
      type: "ALL_PROVIDERS_FAILED",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("omits Authorization header when no apiKey is provided", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okResponse({ outcome: false, confidence: 0.6 }));
    const adapter = makeAdapter({
      providers: [{ url: PROVIDER_URL }],
      fetchFn,
    });

    await adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" });

    const [, init] = fetchFn.mock.calls[0] as [URL, RequestInit];
    expect(
      (init.headers as Record<string, string>)["Authorization"]
    ).toBeUndefined();
  });

  it("throws when constructed with an empty providers array", () => {
    expect(() => new FallbackAdapter({ providers: [] })).toThrow(
      "FallbackAdapter requires at least one provider"
    );
  });

  it("healthCheck returns true when any provider responds healthy", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const adapter = makeAdapter({
      providers: [{ url: PROVIDER_URL }],
      fetchFn,
    });

    expect(await adapter.healthCheck()).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      new URL(`${PROVIDER_URL}/health`),
      expect.anything()
    );
  });

  it("healthCheck returns false when all providers fail", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("connection refused"));
    const adapter = makeAdapter({
      providers: [{ url: PROVIDER_URL }],
      fetchFn,
    });

    expect(await adapter.healthCheck()).toBe(false);
  });

  it("returns the outcome and confidence actually reported by the provider, not a fixed value", async () => {
    const yesFetch = vi
      .fn()
      .mockResolvedValue(okResponse({ outcome: true, confidence: 0.97 }));
    const noFetch = vi
      .fn()
      .mockResolvedValue(okResponse({ outcome: false, confidence: 0.12 }));

    const yesResult = await makeAdapter({ fetchFn: yesFetch }).resolve({
      marketId: "market-1",
      oracleAddress: "GORACLE",
    });
    const noResult = await makeAdapter({ fetchFn: noFetch }).resolve({
      marketId: "market-2",
      oracleAddress: "GORACLE",
    });

    expect(yesResult.outcome).toBe(true);
    expect(yesResult.confidence).toBe(0.97);
    expect(noResult.outcome).toBe(false);
    expect(noResult.confidence).toBe(0.12);
  });

  it("accepts boundary confidence values of exactly 0 and 1", async () => {
    const zeroFetch = vi
      .fn()
      .mockResolvedValue(okResponse({ outcome: false, confidence: 0 }));
    const oneFetch = vi
      .fn()
      .mockResolvedValue(okResponse({ outcome: true, confidence: 1 }));

    const zeroResult = await makeAdapter({ fetchFn: zeroFetch }).resolve({
      marketId: "market-1",
      oracleAddress: "GORACLE",
    });
    const oneResult = await makeAdapter({ fetchFn: oneFetch }).resolve({
      marketId: "market-1",
      oracleAddress: "GORACLE",
    });

    expect(zeroResult.confidence).toBe(0);
    expect(oneResult.confidence).toBe(1);
  });

  it("rejects out-of-range confidence values as INVALID_RESPONSE", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okResponse({ outcome: true, confidence: 1.5 }));
    const adapter = makeAdapter({
      providers: [{ url: PROVIDER_URL }],
      retryConfig: { maxRetries: 0 },
      fetchFn,
    });

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toMatchObject({
      name: "FallbackProviderError",
      type: "ALL_PROVIDERS_FAILED",
    });
  });
});

describe("FallbackAdapter timeout policy (#992)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the documented fallback timeout policy", () => {
    const adapter = makeAdapter();
    expect(adapter.getSource()).toBe("fallback");
  });

  it("fails fast on construction when timeoutMs is out of range in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => makeAdapter({ timeoutMs: 999_999 })).toThrow(
      /refusing to silently clamp/i
    );
  });

  it("clamps an out-of-range timeoutMs outside production instead of throwing", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => makeAdapter({ timeoutMs: 999_999 })).not.toThrow();
  });

  it("fails fast on a per-request timeout override that is out of range in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okResponse({ outcome: true, confidence: 0.9 }));
    const adapter = makeAdapter({ fetchFn });

    await expect(
      adapter.resolve({
        marketId: "market-1",
        oracleAddress: "GORACLE",
        timeoutMs: 500,
      })
    ).rejects.toThrow(/refusing to silently clamp/i);
  });
});

/**
 * #1109 — the fallback adapter is bounded, cancellable, and secret-safe.
 */
describe("FallbackAdapter hardening (#1109)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe("chain bounds", () => {
    it("rejects a chain longer than MAX_FALLBACK_PROVIDERS instead of truncating it", () => {
      const providers = Array.from(
        { length: MAX_FALLBACK_PROVIDERS + 1 },
        (_, i) => ({
          url: `https://fallback-${i}.example.com`,
          source: `fallback-${i + 1}`,
        })
      );

      expect(() => new FallbackAdapter({ providers })).toThrow(
        /at most 8 providers/
      );
    });

    it("accepts a chain of exactly MAX_FALLBACK_PROVIDERS", () => {
      const providers = Array.from(
        { length: MAX_FALLBACK_PROVIDERS },
        (_, i) => ({
          url: `https://fallback-${i}.example.com`,
          source: `fallback-${i + 1}`,
        })
      );

      expect(() => new FallbackAdapter({ providers })).not.toThrow();
    });

    it("rejects a chainTimeoutMs below the per-provider timeout", () => {
      expect(() =>
        makeAdapter({ timeoutMs: 30_000, chainTimeoutMs: 5_000 })
      ).toThrow(/must be >= timeoutMs/);
    });

    it("stops walking the chain once the chain deadline has been consumed", async () => {
      vi.useFakeTimers();

      // The chain budget equals exactly one provider attempt, so the first
      // provider consumes the whole budget and the second is never dialled.
      const fetchFn = vi
        .fn()
        .mockImplementation(() => new Promise<Response>(() => {}));
      const adapter = new FallbackAdapter({
        providers: [
          { url: "https://a.example.com", source: "fallback-1" },
          { url: "https://b.example.com", source: "fallback-2" },
        ],
        timeoutMs: 1_000,
        chainTimeoutMs: 1_000,
        retryConfig: { maxRetries: 0 },
        fetchFn,
      });

      const pending = adapter
        .resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
        .then(
          () => null,
          (e: unknown) => e as FallbackProviderError
        );

      await vi.advanceTimersByTimeAsync(5_000);
      const error = await pending;

      expect(error?.type).toBe("ALL_PROVIDERS_FAILED");
      // The second provider is never dialled — the budget is already spent.
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("secret hygiene", () => {
    it("never puts a URL credential in an error message", async () => {
      const secretUrl =
        "https://user:sup3rs3cret@fallback.example.com/v1?apiKey=sk-live-abc123";
      const fetchFn = vi
        .fn()
        .mockResolvedValue(new Response("nope", { status: 503 }));
      const adapter = new FallbackAdapter({
        providers: [{ url: secretUrl }],
        retryConfig: { maxRetries: 0 },
        fetchFn,
      });

      const error = await adapter
        .resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
        .then(
          () => null,
          (e: unknown) => e as FallbackProviderError
        );

      expect(error?.message).not.toContain("sup3rs3cret");
      expect(error?.message).not.toContain("sk-live-abc123");
      // The host is still identifiable for the operator.
      expect(error?.message).toContain("fallback.example.com");
    });

    it("emits no series label carrying the apiKey", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(okResponse({ outcome: true, confidence: 0.9 }));
      const adapter = new FallbackAdapter({
        providers: [
          {
            url: "https://fallback.example.com?apiKey=sk-live-abc123",
            apiKey: "sk-live-abc123",
          },
        ],
        fetchFn,
      });

      await adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" });

      const snapshot = await oracleFallbackChainAttemptsTotal.get();
      for (const series of snapshot.values) {
        expect(JSON.stringify(series.labels)).not.toContain("sk-live-abc123");
      }
    });

    it("derives a credential-free label from a URL when no source is set", () => {
      expect(
        providerLabel({
          url: "https://user:pw@fallback.example.com:8443/v1?key=abc",
        })
      ).toBe("https://fallback.example.com:8443");
    });

    it("prefers a configured source over the URL", () => {
      expect(
        providerLabel({ url: "https://fallback.example.com", source: "fb-1" })
      ).toBe("fb-1");
    });

    it("returns a fixed marker for an unparseable URL", () => {
      expect(providerLabel({ url: "not-a-url sk-live-abc123" })).toBe(
        "invalid-url"
      );
    });
  });

  describe("cancellation", () => {
    it("aborts the in-flight provider request when the caller signals", async () => {
      const seenSignals: AbortSignal[] = [];
      const fetchFn = vi
        .fn()
        .mockImplementation((_url: URL, init: RequestInit) => {
          seenSignals.push(init.signal as AbortSignal);
          return new Promise<Response>(() => {});
        });
      const adapter = makeAdapter({ fetchFn });

      const controller = new AbortController();
      const pending = adapter
        .resolve({
          marketId: "market-1",
          oracleAddress: "GORACLE",
          signal: controller.signal,
        })
        .catch(() => "aborted");
      controller.abort();

      expect(await pending).toBe("aborted");
      expect(seenSignals[0]?.aborted).toBe(true);
    });
  });

  describe("adversarial provider responses", () => {
    it("classifies a non-JSON 200 body as INVALID_RESPONSE", async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          new Response("<html>gateway</html>", { status: 200 })
        );
      const adapter = makeAdapter({
        providers: [{ url: PROVIDER_URL }],
        fetchFn,
        retryConfig: { maxRetries: 0 },
      });

      await expect(
        adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
      ).rejects.toMatchObject({ type: "ALL_PROVIDERS_FAILED" });
    });

    it("rejects a non-numeric confidence value", async () => {
      const adapter = makeAdapter({
        fetchFn: vi
          .fn()
          .mockResolvedValue(okResponse({ outcome: true, confidence: null })),
        retryConfig: { maxRetries: 0 },
      });

      await expect(
        adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
      ).rejects.toMatchObject({ type: "ALL_PROVIDERS_FAILED" });
    });

    it("rejects an unparseable provider timestamp", async () => {
      const adapter = makeAdapter({
        fetchFn: vi.fn().mockResolvedValue(
          okResponse({
            outcome: true,
            confidence: 0.9,
            timestamp: "not-a-date",
          })
        ),
        retryConfig: { maxRetries: 0 },
      });

      await expect(
        adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
      ).rejects.toMatchObject({ type: "ALL_PROVIDERS_FAILED" });
    });
  });
});

/**
 * Failover telemetry (#1147). The chain must record an outcome for every
 * provider it tried, keyed by that provider's `source`, so operators can see
 * which fallback is carrying traffic and which one is failing.
 */
describe("FallbackAdapter chain metrics (#1147)", () => {
  const NO_RETRY = {
    maxRetries: 0,
    initialDelayMs: 1,
    maxDelayMs: 1,
    factor: 1,
    useJitter: false,
  };

  async function chainValue(
    provider: string,
    outcome: string
  ): Promise<number> {
    const { values } = await oracleFallbackChainAttemptsTotal.get();
    return values
      .filter(
        (series) =>
          series.labels["provider"] === provider &&
          series.labels["outcome"] === outcome
      )
      .reduce((sum, series) => sum + series.value, 0);
  }

  it("records the failure of the first provider and the success of the second", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ error: "upstream down" }, 500))
      .mockResolvedValueOnce(okResponse({ outcome: false, confidence: 0.9 }));

    const adapter = new FallbackAdapter({
      providers: [
        { url: "https://one.example.com", source: "fallback-1" },
        { url: "https://two.example.com", source: "fallback-2" },
      ],
      retryConfig: NO_RETRY,
      fetchFn,
    });

    const firstFailureBefore = await chainValue("fallback-1", "failure");
    const secondSuccessBefore = await chainValue("fallback-2", "success");

    const result = await adapter.resolve({
      marketId: "market-1",
      oracleAddress: "GORACLE",
    });

    expect(result.source).toBe("fallback-2");
    expect(await chainValue("fallback-1", "failure")).toBe(
      firstFailureBefore + 1
    );
    expect(await chainValue("fallback-2", "success")).toBe(
      secondSuccessBefore + 1
    );
  });

  it("records a failure for every provider when the whole chain is down", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(okResponse({ error: "upstream down" }, 503));

    const adapter = new FallbackAdapter({
      providers: [
        { url: "https://one.example.com", source: "fallback-1" },
        { url: "https://two.example.com", source: "fallback-2" },
      ],
      retryConfig: NO_RETRY,
      fetchFn,
    });

    const before1 = await chainValue("fallback-1", "failure");
    const before2 = await chainValue("fallback-2", "failure");

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toThrow(FallbackProviderError);

    expect(await chainValue("fallback-1", "failure")).toBe(before1 + 1);
    expect(await chainValue("fallback-2", "failure")).toBe(before2 + 1);
  });
});
