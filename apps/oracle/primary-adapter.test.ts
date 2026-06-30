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
});
