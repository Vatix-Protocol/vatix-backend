import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The gap sender resolves the webhook host through node:dns/promises. Mock it
// so each test controls what the resolver does without touching the network.
const { dnsLookupMock } = vi.hoisted(() => ({ dnsLookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));

import { GapDetector } from "./gapDetector.js";
import type { EventFetcher } from "./eventFetcher.js";
import type { BatchWriter } from "./batchWriter.js";
import type { InternalIndexerMetricsService } from "./metrics.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";

// ---------------------------------------------------------------------------
// #1558 — a DNS failure while checking the paging webhook host must fail
// closed: no fetch, and the "blocked" counter increments.
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
  } as unknown as InternalIndexerMetricsService;
}

function makeEventFetcher(): EventFetcher {
  return {
    fetchByLedgerWindow: vi
      .fn()
      .mockResolvedValue({ events: [], latestLedger: 1000 }),
  } as unknown as EventFetcher;
}

function makeBatchWriter(): BatchWriter {
  return {
    write: vi.fn().mockResolvedValue({ written: 0, skipped: 0, errors: [] }),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

function makeProductionDetector(metrics: InternalIndexerMetricsService) {
  return new GapDetector(
    {
      gapPauseThreshold: 0,
      backfillMaxLedgers: 500,
      contractId: "CTEST",
      // Production enforces the public-host check at send time.
      nodeEnv: "production",
      backfillEnabled: true,
      pagingConfig: {
        webhookUrl: "https://alerts.example.com/hooks/gap",
        persistenceCyclesBeforePage: 1,
      },
    },
    makeEventFetcher(),
    makeBatchWriter(),
    metrics,
    makeLogger()
  );
}

describe("GapDetector paging webhook — DNS failure fails closed (#1558)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    dnsLookupMock.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not call fetch and counts the page as blocked when the lookup rejects", async () => {
    dnsLookupMock.mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND alerts.example.com"), {
        code: "ENOTFOUND",
      })
    );
    const metrics = makeMetrics();
    const detector = makeProductionDetector(metrics);

    await detector.runBackfill(100, 110);

    expect(dnsLookupMock).toHaveBeenCalledWith(
      "alerts.example.com",
      expect.anything()
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metrics.incrementGapPagingWebhook).toHaveBeenCalledTimes(1);
    expect(metrics.incrementGapPagingWebhook).toHaveBeenCalledWith("blocked");
  });

  it("does not call fetch and counts the page as blocked when the lookup returns []", async () => {
    dnsLookupMock.mockResolvedValue([]);
    const metrics = makeMetrics();
    const detector = makeProductionDetector(metrics);

    await detector.runBackfill(100, 110);

    expect(dnsLookupMock).toHaveBeenCalledWith(
      "alerts.example.com",
      expect.anything()
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(metrics.incrementGapPagingWebhook).toHaveBeenCalledTimes(1);
    expect(metrics.incrementGapPagingWebhook).toHaveBeenCalledWith("blocked");
  });

  it("sends the page when the host resolves to a public address (control)", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const metrics = makeMetrics();
    const detector = makeProductionDetector(metrics);

    await detector.runBackfill(100, 110);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metrics.incrementGapPagingWebhook).toHaveBeenCalledWith("sent");
    expect(metrics.incrementGapPagingWebhook).not.toHaveBeenCalledWith(
      "blocked"
    );
  });
});
