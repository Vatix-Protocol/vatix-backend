import { describe, expect, it, vi } from "vitest";
import { FallbackAdapter, FallbackProviderError } from "./fallback-adapter.js";
import type { FallbackAdapterConfig } from "./fallback-adapter.js";

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
});
