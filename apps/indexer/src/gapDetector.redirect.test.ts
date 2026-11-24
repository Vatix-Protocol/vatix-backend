import { describe, it, expect, vi, afterEach } from "vitest";
import { GapDetector } from "./gapDetector.js";
import type { EventFetcher } from "./eventFetcher.js";
import type { BatchWriter } from "./batchWriter.js";
import type { InternalIndexerMetricsService } from "./metrics.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ILogger;
}

function makeMetrics(): InternalIndexerMetricsService {
  return {
    incrementGapDetected: vi.fn(),
    incrementBackfillLedgers: vi.fn(),
    incrementGapBackfillOutcome: vi.fn(),
    incrementGapPagingWebhook: vi.fn(),
    incrementBatchRejected: vi.fn(),
    getGapDetectedTotal: vi.fn().mockReturnValue(0),
    getBackfillLedgersTotal: vi.fn().mockReturnValue(0),
  } as unknown as InternalIndexerMetricsService;
}

function makeEventFetcher(): EventFetcher {
  return {
    fetchByLedgerWindow: vi
      .fn()
      .mockResolvedValue({ events: [], latestLedger: 1000 }),
    getLatestLedgerInfo: vi
      .fn()
      .mockResolvedValue({ sequence: 1000, hash: "abc" }),
  } as unknown as EventFetcher;
}

function makeBatchWriter(): BatchWriter {
  return {
    write: vi.fn().mockResolvedValue({ written: 0, skipped: 0, errors: [] }),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * A fetch stub whose server always answers 302 to a second host. It behaves
 * like the platform fetch: with `redirect: "error"` the redirect is refused
 * and the call rejects; with any other mode it follows the Location header
 * by issuing a second request.
 */
function makeRedirectingFetch(redirectTarget: string) {
  const fetchImpl = vi.fn(
    async (_url: string, init?: RequestInit): Promise<Response> => {
      if (init?.redirect === "error") {
        throw new TypeError("fetch failed: unexpected redirect");
      }
      return fetchImpl(redirectTarget, { ...init, method: "GET" });
    }
  );
  return fetchImpl;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GapDetector paging webhook redirects (#1559)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not follow a 302 to a second host and records the failure", async () => {
    const webhookUrl = "https://alerts.example.com/hooks/gap?token=page-secret";
    const fetchImpl = makeRedirectingFetch(
      "https://attacker.example.net/collect"
    );
    vi.stubGlobal("fetch", fetchImpl);

    const logger = makeLogger();
    const metrics = makeMetrics();
    const detector = new GapDetector(
      {
        gapPauseThreshold: 0,
        backfillMaxLedgers: 500,
        contractId: "CTEST",
        pagingConfig: { webhookUrl, persistenceCyclesBeforePage: 1 },
      },
      makeEventFetcher(),
      makeBatchWriter(),
      metrics,
      logger
    );

    await expect(detector.runBackfill(100, 110)).resolves.toBeDefined();

    // Exactly one request was attempted, and redirects were refused.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.redirect).toBe("error");

    // The paging function recorded an error instead of a successful send.
    expect(metrics.incrementGapPagingWebhook).toHaveBeenCalledWith("failed");
    expect(metrics.incrementGapPagingWebhook).not.toHaveBeenCalledWith("sent");
    expect(logger.warn).toHaveBeenCalledWith(
      "Failed to send gap paging alert",
      expect.objectContaining({ event: "indexer.gap.paging.error" })
    );

    // No log line carries the webhook URL or the redirect target. Compare
    // against host/token fragments so the URL itself is never echoed by the
    // assertion.
    const loggedText = [
      ...vi.mocked(logger.debug).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ]
      .map((call) => JSON.stringify(call))
      .join("\n");
    for (const fragment of [
      "alerts.example.com",
      "page-secret",
      "attacker.example.net",
    ]) {
      expect(loggedText.includes(fragment)).toBe(false);
    }
  });
});
