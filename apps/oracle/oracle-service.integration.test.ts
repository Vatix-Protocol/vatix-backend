/**
 * Oracle service integration tests (#1111).
 *
 * These exercise the *real* `OracleService` wired to the *real* adapters — no
 * adapter doubles — with only the HTTP transport (`fetchFn`) and the enqueue
 * boundary stubbed. That is the critical money path: a resolution that is
 * resolved, scored, and enqueued, or refused fail-closed.
 *
 * Covered end-to-end:
 *  - primary success -> enqueue, no fallback traffic;
 *  - primary timeout -> the fallback chain answers, and the chain is bounded;
 *  - every provider down -> fail closed, nothing enqueued, metric increments;
 *  - the confidence gate refuses a weak signal before it reaches the queue;
 *  - dry-run resolves and scores but never enqueues;
 *  - caller cancellation propagates through the chain;
 *  - no provider credential reaches an error message.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OracleService } from "./oracle-service.js";
import { PrimaryAdapter } from "./primary-adapter.js";
import {
  FallbackAdapter,
  type FallbackProviderConfig,
} from "./fallback-adapter.js";
import type { ProviderResult, ResolutionRequest } from "./provider-adapter.js";
import type { SubmissionQueueItem } from "./submission-queue.js";
import { oracleFailClosedTotal } from "../../src/services/metrics.js";

const REQUEST: ResolutionRequest = {
  marketId: "integration-market",
  oracleAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

/** A provider response the adapters accept as well-formed. */
function providerBody(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      outcome: true,
      confidence: 0.95,
      timestamp: "2026-01-01T00:00:00.000Z",
      ...overrides,
    }),
    { status: 200 }
  );
}

const asFetch = (fn: unknown) => fn as typeof fetch;

/** Build a real FallbackAdapter over a stub transport. */
function realFallback(
  providers: FallbackProviderConfig[],
  fetchFn: unknown
): FallbackAdapter {
  return new FallbackAdapter({
    providers,
    fetchFn: asFetch(fetchFn),
    retryConfig: { maxRetries: 0 },
  });
}

/** Sum every series of a prometheus counter. */
async function counterTotal(counter: {
  get(): Promise<{ values: Array<{ value: number }> }>;
}): Promise<number> {
  const snapshot = await counter.get();
  return snapshot.values.reduce((sum, v) => sum + v.value, 0);
}

describe("OracleService end-to-end over the real adapters", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("resolves via the primary and enqueues exactly once", async () => {
    const primaryFetch = vi.fn().mockResolvedValue(providerBody());
    const fallbackFetch = vi.fn();
    const enqueueCallback = vi.fn().mockResolvedValue(undefined);

    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(primaryFetch),
      }),
      fallbackAdapter: realFallback(
        [{ url: "https://fallback.example.com", source: "fallback-1" }],
        fallbackFetch
      ),
      enqueueCallback,
    });

    const result = await service.resolve(REQUEST);

    expect(result.outcome).toBe(true);
    expect(result.source).toBe("primary");
    expect(fallbackFetch).not.toHaveBeenCalled();
    expect(enqueueCallback).toHaveBeenCalledTimes(1);

    const item = enqueueCallback.mock.calls[0][0] as SubmissionQueueItem;
    expect(item.request.marketId).toBe(REQUEST.marketId);
    expect(item.result.confidence).toBe(0.95);
    expect(item.status).toBe("pending");
  });

  it("fails over to the fallback chain when the primary times out", async () => {
    vi.useFakeTimers();

    // The primary never answers; the fallback does.
    const primaryFetch = vi
      .fn()
      .mockImplementation(() => new Promise<Response>(() => {}));
    const fallbackFetch = vi
      .fn()
      .mockResolvedValue(providerBody({ confidence: 0.81, outcome: false }));
    const enqueueCallback = vi.fn().mockResolvedValue(undefined);

    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        timeoutMs: 5_000,
        fetchFn: asFetch(primaryFetch),
      }),
      fallbackAdapter: realFallback(
        [{ url: "https://fallback.example.com", source: "fallback-1" }],
        fallbackFetch
      ),
      enqueueCallback,
      enableFallback: true,
      primaryTimeoutMs: 5_000,
      fallbackTimeoutMs: 5_000,
    });

    const pending = service.resolve(REQUEST);
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await pending;

    expect(result.source).toBe("fallback-1");
    expect(result.confidence).toBe(0.81);
    expect(enqueueCallback).toHaveBeenCalledTimes(1);
  });

  it("fails closed and enqueues nothing when every provider is down", async () => {
    const downFetch = vi
      .fn()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    const enqueueCallback = vi.fn().mockResolvedValue(undefined);
    const before = await counterTotal(oracleFailClosedTotal);

    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(downFetch),
      }),
      fallbackAdapter: realFallback(
        [
          { url: "https://fb-a.example.com", source: "fallback-1" },
          { url: "https://fb-b.example.com", source: "fallback-2" },
        ],
        downFetch
      ),
      enqueueCallback,
      enableFallback: true,
    });

    await expect(service.resolve(REQUEST)).rejects.toThrow();

    // Fail closed: no report, no submission.
    expect(enqueueCallback).not.toHaveBeenCalled();
    expect(await counterTotal(oracleFailClosedTotal)).toBe(before + 1);
    expect(service.getMetrics().totalOutageCount).toBe(1);
  });

  it("stops at the first healthy link rather than calling every provider", async () => {
    const primaryFetch = vi
      .fn()
      .mockResolvedValue(new Response("bad gateway", { status: 502 }));
    const chainFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(providerBody({ confidence: 0.77 }));

    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(primaryFetch),
      }),
      fallbackAdapter: realFallback(
        [
          { url: "https://fb-a.example.com", source: "fallback-1" },
          { url: "https://fb-b.example.com", source: "fallback-2" },
          { url: "https://fb-c.example.com", source: "fallback-3" },
        ],
        chainFetch
      ),
      enableFallback: true,
    });

    const result = await service.resolve(REQUEST);

    expect(result.source).toBe("fallback-2");
    // The third link is never dialled once the second answered.
    expect(chainFetch).toHaveBeenCalledTimes(2);
  });

  it("refuses a below-threshold result before it can reach the submission queue", async () => {
    const enqueueCallback = vi.fn().mockResolvedValue(undefined);

    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(
          vi.fn().mockResolvedValue(providerBody({ confidence: 0.3 }))
        ),
      }),
      fallbackAdapter: realFallback(
        [{ url: "https://fb.example.com", source: "fallback-1" }],
        vi.fn()
      ),
      enqueueCallback,
      minConfidenceThreshold: 0.75,
    });

    await expect(service.resolve(REQUEST)).rejects.toThrow(/confidence/i);
    expect(enqueueCallback).not.toHaveBeenCalled();
  });

  it("treats an out-of-range confidence from the provider as an invalid response", async () => {
    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(
          vi.fn().mockResolvedValue(providerBody({ confidence: 1.5 }))
        ),
      }),
      fallbackAdapter: realFallback(
        [{ url: "https://fb.example.com", source: "fallback-1" }],
        vi.fn()
      ),
      enableFallback: false,
    });

    await expect(service.resolve(REQUEST)).rejects.toThrow();
  });

  it("resolves and scores in dry-run but never enqueues", async () => {
    const enqueueCallback = vi.fn().mockResolvedValue(undefined);

    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(vi.fn().mockResolvedValue(providerBody())),
      }),
      fallbackAdapter: realFallback(
        [{ url: "https://fb.example.com", source: "fallback-1" }],
        vi.fn()
      ),
      enqueueCallback,
      dryRun: true,
    });

    const result = await service.resolve(REQUEST);

    expect(result.confidence).toBe(0.95);
    expect(service.isDryRun()).toBe(true);
    expect(enqueueCallback).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation through the whole chain", async () => {
    const seenSignals: AbortSignal[] = [];
    const hang = vi.fn().mockImplementation((_url: URL, init: RequestInit) => {
      seenSignals.push(init.signal as AbortSignal);
      return new Promise<Response>(() => {});
    });

    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(hang),
      }),
      fallbackAdapter: realFallback(
        [{ url: "https://fb.example.com", source: "fallback-1" }],
        hang
      ),
      enableFallback: true,
    });

    const controller = new AbortController();
    const pending = service
      .resolve({ ...REQUEST, signal: controller.signal })
      .then(
        () => null,
        () => "cancelled" as const
      );
    controller.abort();

    expect(await pending).toBe("cancelled");
    // Every provider that was dialled got told to stop.
    expect(seenSignals.length).toBeGreaterThan(0);
    expect(seenSignals.every((s) => s.aborted)).toBe(true);
  });

  it("never leaks a provider credential into the failure surfaced to the operator", async () => {
    const secretUrl =
      "https://user:sup3rs3cret@fb.example.com?apiKey=sk-live-xyz";
    const down = vi
      .fn()
      .mockResolvedValue(new Response("down", { status: 503 }));

    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(down),
      }),
      fallbackAdapter: realFallback(
        [{ url: secretUrl, source: "fallback-1" }],
        down
      ),
      enableFallback: true,
    });

    const error = await service.resolve(REQUEST).then(
      () => null,
      (e: unknown) => e as Error
    );

    expect(error?.message).not.toContain("sup3rs3cret");
    expect(error?.message).not.toContain("sk-live-xyz");
  });

  it("reports unhealthy when the primary health probe cannot reach the provider", async () => {
    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))),
      }),
      fallbackAdapter: realFallback(
        [{ url: "https://fb.example.com", source: "fallback-1" }],
        vi.fn()
      ),
    });

    expect(await service.healthCheck()).toBe(false);
  });

  it("keeps the ProviderResult contract intact across failover", async () => {
    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(
          vi
            .fn()
            .mockResolvedValue(new Response("bad gateway", { status: 502 }))
        ),
      }),
      fallbackAdapter: realFallback(
        [{ url: "https://fb.example.com", source: "fallback-1" }],
        vi
          .fn()
          .mockResolvedValue(providerBody({ confidence: 0.88, outcome: false }))
      ),
      enableFallback: true,
    });

    const result: ProviderResult = await service.resolve(REQUEST);

    expect(typeof result.outcome).toBe("boolean");
    expect(result.confidenceMetadata.score).toBe(0.88);
    expect(result.sourceMetadata.provider).toBe("fallback-1");
    expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
  });
});

/**
 * Production fail-closed: under `NODE_ENV=production` the service must not
 * reach an off-chain fallback even when one is configured and explicitly
 * enabled, so no secondary, stale, or default value can ever be signed.
 */
describe("OracleService production fail-closed over the real adapters", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not call the fallback chain when the primary is down in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const fallbackFetch = vi.fn().mockResolvedValue(providerBody());
    const enqueueCallback = vi.fn().mockResolvedValue(undefined);

    const service = new OracleService({
      primaryAdapter: new PrimaryAdapter({
        baseUrl: "https://primary.example.com",
        fetchFn: asFetch(
          vi.fn().mockResolvedValue(new Response("down", { status: 503 }))
        ),
      }),
      fallbackAdapter: realFallback(
        [{ url: "https://fb.example.com", source: "fallback-1" }],
        fallbackFetch
      ),
      enqueueCallback,
      enableFallback: true, // must be overridden by the production policy
    });

    await expect(service.resolve(REQUEST)).rejects.toThrow();

    expect(fallbackFetch).not.toHaveBeenCalled();
    expect(enqueueCallback).not.toHaveBeenCalled();
  });
});
