import { describe, expect, it, vi } from "vitest";
import { PrimaryAdapter, PrimaryProviderError } from "./primary-adapter.js";

describe("PrimaryAdapter", () => {
  it("maps a mocked provider response to a provider result", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          outcome: false,
          confidence: 0.91,
          timestamp: "2026-01-01T00:00:00.000Z",
          metadata: { providerRequestId: "req-1" },
        }),
        { status: 200 }
      )
    );
    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      apiKey: "test-key",
      fetchFn,
    });

    const result = await adapter.resolve({
      marketId: "market-1",
      oracleAddress: "GORACLE",
    });

    expect(result).toMatchObject({
      outcome: false,
      confidence: 0.91,
      source: "primary",
      timestamp: "2026-01-01T00:00:00.000Z",
      metadata: {
        provider: "primary",
        marketId: "market-1",
        providerRequestId: "req-1",
      },
    });
    expect(fetchFn).toHaveBeenCalledWith(
      new URL(
        "https://primary.example.com/resolve?marketId=market-1&oracleAddress=GORACLE"
      ),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer test-key",
        }),
      })
    );
  });

  it("maps provider HTTP errors to internal error types", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("rate limited", { status: 429 }));
    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
    });

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toMatchObject({
      name: "PrimaryProviderError",
      type: "RATE_LIMIT",
    } satisfies Partial<PrimaryProviderError>);
  });

  it("maps 401 response to AUTHENTICATION error", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
    });

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toMatchObject({
      name: "PrimaryProviderError",
      type: "AUTHENTICATION",
    });
  });

  it("maps 404 response to NOT_FOUND error", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("not found", { status: 404 }));
    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
    });

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toMatchObject({
      name: "PrimaryProviderError",
      type: "NOT_FOUND",
    });
  });

  it("throws INVALID_RESPONSE when payload is missing required fields", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ outcome: true }), // missing confidence
        { status: 200 }
      )
    );
    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
    });

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toMatchObject({
      name: "PrimaryProviderError",
      type: "INVALID_RESPONSE",
    });
  });

  it("throws TIMEOUT error when request exceeds per-adapter timeoutMs", async () => {
    // fetchFn never resolves — simulates a hanging request
    const fetchFn = vi.fn().mockImplementation(
      (_url: unknown, opts: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener("abort", () =>
              reject(new DOMException("AbortError", "AbortError"))
            );
          }
        })
    );

    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
      timeoutMs: 50, // very short so test doesn't hang
    });

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toMatchObject({
      name: "PrimaryProviderError",
      type: "TIMEOUT",
    });
  });

  it("respects per-request timeoutMs override", async () => {
    const fetchFn = vi.fn().mockImplementation(
      (_url: unknown, opts: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener("abort", () =>
              reject(new DOMException("AbortError", "AbortError"))
            );
          }
        })
    );

    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
      timeoutMs: 60_000, // adapter default is very long
    });

    await expect(
      adapter.resolve({
        marketId: "market-1",
        oracleAddress: "GORACLE",
        timeoutMs: 50, // per-request override is short
      })
    ).rejects.toMatchObject({
      name: "PrimaryProviderError",
      type: "TIMEOUT",
    });
  });

  it("retries on transient failures using adapter-level retryConfig", async () => {
    const successResponse = new Response(
      JSON.stringify({ outcome: true, confidence: 0.8 }),
      { status: 200 }
    );
    // Fail twice, then succeed
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValue(successResponse);

    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
      retryConfig: { maxRetries: 3, initialDelayMs: 1, useJitter: false },
    });

    const result = await adapter.resolve({
      marketId: "market-1",
      oracleAddress: "GORACLE",
    });

    expect(result.outcome).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("per-request retryConfig overrides adapter-level retryConfig", async () => {
    const successResponse = new Response(
      JSON.stringify({ outcome: true, confidence: 0.8 }),
      { status: 200 }
    );
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValue(successResponse);

    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
      retryConfig: { maxRetries: 0 }, // adapter default: no retries
    });

    const result = await adapter.resolve({
      marketId: "market-1",
      oracleAddress: "GORACLE",
      retryConfig: { maxRetries: 2, initialDelayMs: 1, useJitter: false }, // per-request override
    });

    expect(result.outcome).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry on non-transient errors (4xx)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response("not found", { status: 404 })
    );

    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
      retryConfig: { maxRetries: 3, initialDelayMs: 1, useJitter: false },
    });

    await expect(
      adapter.resolve({ marketId: "market-1", oracleAddress: "GORACLE" })
    ).rejects.toMatchObject({ type: "NOT_FOUND" });

    // Should only be called once — 4xx is not retryable
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("healthCheck returns true when /health is reachable", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
    });

    expect(await adapter.healthCheck()).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      new URL("https://primary.example.com/health"),
      expect.anything()
    );
  });

  it("healthCheck returns false when /health returns non-2xx", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response("error", { status: 503 }));
    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
    });

    expect(await adapter.healthCheck()).toBe(false);
  });

  it("healthCheck returns false when fetch throws", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error("Connection refused"));
    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
      fetchFn,
    });

    expect(await adapter.healthCheck()).toBe(false);
  });

  it("getSource returns 'primary'", () => {
    const adapter = new PrimaryAdapter({
      baseUrl: "https://primary.example.com",
    });
    expect(adapter.getSource()).toBe("primary");
  });
});
