/**
 * Gap back-fill job hardening (#1151): kill-switch, concurrency (replay)
 * guard, typed errors with correlation ids, and fail-closed handling of a
 * dependency outage on the write path.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { GapDetector, GapBackfillError } from "./gapDetector.js";
import { BatchWriteError } from "./batchWriterError.js";
import type { EventFetcher } from "./eventFetcher.js";
import type { BatchWriter } from "./batchWriter.js";
import type { InternalIndexerMetricsService } from "./metrics.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";

// Fabricate one normalized trade per event so `records.length > 0` and the
// batch writer is actually exercised (real parsers need XDR payloads).
vi.mock("./tradeParser.js", () => ({
  parseTradeEvents: (events: Array<{ ledger: number }>) => ({
    trades: events.map((event) => ({
      eventId: `${String(event.ledger).padStart(10, "0")}-0000000001-0000000000`,
      ledger: event.ledger,
      ledgerClosedAt: "2024-01-01T00:00:00.000Z",
      contractId: "CTEST",
      marketId: "market-abc",
      traderAddress: "GABC",
      counterpartyAddress: "GXYZ",
      direction: "buy",
      outcome: "YES",
      priceRaw: 5_000_000n,
      quantityRaw: 100n,
      buyOrderId: "buy-1",
      sellOrderId: "sell-1",
    })),
    errors: [],
  }),
}));

function makeLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ILogger;
}

function makeMetrics() {
  return {
    incrementGapDetected: vi.fn(),
    incrementBackfillLedgers: vi.fn(),
    incrementGapBackfillOutcome: vi.fn(),
    incrementBatchRejected: vi.fn(),
  } as unknown as InternalIndexerMetricsService;
}

function makeEventFetcher(
  events: Array<{ ledger: number }> = []
): EventFetcher {
  return {
    fetchByLedgerWindow: vi.fn().mockResolvedValue({
      events,
      latestLedger: 1000,
    }),
    getLatestLedgerInfo: vi
      .fn()
      .mockResolvedValue({ sequence: 1000, hash: "abc" }),
  } as unknown as EventFetcher;
}

function makeBatchWriter(
  result = { written: 0, skipped: 0, errors: [] }
): BatchWriter {
  return {
    write: vi.fn().mockResolvedValue(result),
    flush: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDetector(overrides: Partial<Record<string, unknown>> = {}) {
  const fetcher = (overrides.fetcher as EventFetcher) ?? makeEventFetcher();
  const writer = (overrides.writer as BatchWriter) ?? makeBatchWriter();
  const metrics =
    (overrides.metrics as InternalIndexerMetricsService) ?? makeMetrics();
  const logger = (overrides.logger as ILogger) ?? makeLogger();

  const detector = new GapDetector(
    {
      gapPauseThreshold: (overrides.gapPauseThreshold as number) ?? 1000,
      backfillMaxLedgers: (overrides.backfillMaxLedgers as number) ?? 500,
      contractId: "CTEST",
      backfillEnabled: overrides.backfillEnabled as boolean | undefined,
      nodeEnv: overrides.nodeEnv as string | undefined,
    },
    fetcher,
    writer,
    metrics,
    logger
  );

  return { detector, fetcher, writer, metrics, logger };
}

describe("GapDetector.runBackfill job guards (#1151)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not fetch or write when the kill-switch disables back-fill", async () => {
    const { detector, fetcher, writer, metrics, logger } = makeDetector({
      backfillEnabled: false,
    });

    const result = await detector.runBackfill(100, 110);

    expect(result).toMatchObject({
      paused: true,
      pausedReason: "disabled",
      backfilledLedgers: 0,
      written: 0,
      skipped: 0,
    });
    expect(result.correlationId).toBeTruthy();
    expect(fetcher.fetchByLedgerWindow).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenCalledWith(
      "disabled"
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "Ledger gap back-fill disabled by kill-switch",
      expect.objectContaining({ event: "indexer.gap.backfill.disabled" })
    );
  });

  it("rejects a malformed range with a typed, non-retryable error", async () => {
    const { detector, fetcher, metrics } = makeDetector();

    const error = await detector.runBackfill(110, 100).catch((e) => e);

    expect(error).toBeInstanceOf(GapBackfillError);
    expect(error.code).toBe("GAP_BACKFILL_INVALID_RANGE");
    expect(error.retryable).toBe(false);
    expect(error.correlationId).toBeTruthy();
    expect(fetcher.fetchByLedgerWindow).not.toHaveBeenCalled();
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenCalledWith("failed");
  });

  it("rejects a non-integer range (adversarial input)", async () => {
    const { detector, fetcher } = makeDetector();

    await expect(detector.runBackfill(1.5, 10)).rejects.toMatchObject({
      code: "GAP_BACKFILL_INVALID_RANGE",
    });
    expect(fetcher.fetchByLedgerWindow).not.toHaveBeenCalled();
  });

  it("denies a concurrent back-fill run instead of double-fetching", async () => {
    let releaseFetch: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      releaseFetch = resolve;
    });

    const fetcher = {
      fetchByLedgerWindow: vi.fn().mockReturnValue(pending),
      getLatestLedgerInfo: vi.fn(),
    } as unknown as EventFetcher;
    const writer = makeBatchWriter();
    const metrics = makeMetrics();

    const { detector } = makeDetector({ fetcher, writer, metrics });

    const first = detector.runBackfill(100, 110);
    const second = await detector.runBackfill(100, 110);

    expect(second).toMatchObject({
      paused: true,
      pausedReason: "in_progress",
      backfilledLedgers: 0,
    });
    expect(second.correlationId).toBeTruthy();
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenCalledWith(
      "in_progress"
    );
    // Only one fetch was ever issued for the overlapping range.
    expect(fetcher.fetchByLedgerWindow).toHaveBeenCalledTimes(1);

    releaseFetch({ events: [], latestLedger: 1000 });
    const settled = await first;
    expect(settled.paused).toBe(false);
    expect(settled.correlationId).toBeTruthy();
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenCalledWith(
      "completed"
    );
  });

  it("releases the in-flight lock after a completed run", async () => {
    const { detector, metrics } = makeDetector();

    await detector.runBackfill(100, 110);
    const second = await detector.runBackfill(100, 110);

    expect(second.paused).toBe(false);
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenLastCalledWith(
      "completed"
    );
  });

  it("honours the INDEXER_GAP_BACKFILL_ENABLED kill-switch env var", async () => {
    vi.stubEnv("INDEXER_GAP_BACKFILL_ENABLED", "false");
    const { detector, fetcher, metrics } = makeDetector();

    const result = await detector.runBackfill(100, 110);

    expect(result).toMatchObject({
      paused: true,
      pausedReason: "disabled",
    });
    expect(fetcher.fetchByLedgerWindow).not.toHaveBeenCalled();
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenCalledWith(
      "disabled"
    );

    vi.unstubAllEnvs();
  });

  it("keeps back-fill enabled for an unrecognised kill-switch value", async () => {
    vi.stubEnv("INDEXER_GAP_BACKFILL_ENABLED", "maybe");
    const { detector, fetcher } = makeDetector();

    const result = await detector.runBackfill(100, 110);

    expect(result.paused).toBe(false);
    expect(fetcher.fetchByLedgerWindow).toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});

describe("GapDetector.runBackfill fail-closed write handling (#1151)", () => {
  function eventFetcherWithOneEvent() {
    return {
      fetchByLedgerWindow: vi.fn().mockResolvedValue({
        events: [
          {
            id: "0000000101-0000000001-0000000000",
            ledger: 101,
            ledgerClosedAt: "2024-01-01T00:00:00Z",
            contractId: "CTEST",
            type: "contract",
            pagingToken: "p1",
            valueXdr: "AAAAAA==",
            topicsXdr: [],
          },
        ],
        latestLedger: 1000,
      }),
      getLatestLedgerInfo: vi.fn(),
    } as unknown as EventFetcher;
  }

  it("pauses (fail-closed) when the batch write hits a dependency outage", async () => {
    const writer = makeBatchWriter();
    writer.write = vi
      .fn()
      .mockRejectedValue(
        new BatchWriteError(
          "BATCH_WRITE_DEPENDENCY_UNAVAILABLE",
          "Batch write aborted: dependency unavailable",
          "bw_test"
        )
      );
    const metrics = makeMetrics();
    const { detector } = makeDetector({
      fetcher: eventFetcherWithOneEvent(),
      writer,
      metrics,
    });

    const result = await detector.runBackfill(100, 110);

    expect(result).toMatchObject({
      paused: true,
      pausedReason: "dependency_unavailable",
      backfilledLedgers: 0,
      written: 0,
      skipped: 0,
    });
    expect(result.correlationId).toBeTruthy();
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenCalledWith(
      "dependency_unavailable"
    );
    // The cursor must not advance past un-back-filled ledgers: backfill
    // ledgers are never credited for a failed run.
    expect(metrics.incrementBackfillLedgers).not.toHaveBeenCalled();
  });

  it("wraps unexpected failures in a typed, retryable GapBackfillError", async () => {
    const writer = makeBatchWriter();
    writer.write = vi.fn().mockRejectedValue(new Error("boom"));
    const metrics = makeMetrics();
    const logger = makeLogger();
    const { detector } = makeDetector({
      fetcher: eventFetcherWithOneEvent(),
      writer,
      metrics,
      logger,
    });

    const error = await detector.runBackfill(100, 110).catch((e) => e);

    expect(error).toBeInstanceOf(GapBackfillError);
    expect(error.code).toBe("GAP_BACKFILL_FAILED");
    expect(error.retryable).toBe(true);
    expect(error.correlationId).toBeTruthy();
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenCalledWith("failed");
    expect(logger.error).toHaveBeenCalledWith(
      "Ledger gap back-fill failed",
      expect.objectContaining({ event: "indexer.gap.backfill.failed" })
    );
  });

  it("reports the threshold pause with its reason and outcome metric", async () => {
    const metrics = makeMetrics();
    const { detector } = makeDetector({ gapPauseThreshold: 5, metrics });

    const result = await detector.runBackfill(100, 110);

    expect(result).toMatchObject({
      paused: true,
      pausedReason: "threshold",
      backfilledLedgers: 0,
    });
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenCalledWith("paused");
    expect(metrics.incrementBackfillLedgers).not.toHaveBeenCalled();
  });

  it("still clamps oversized ranges and records a completed outcome", async () => {
    const metrics = makeMetrics();
    const fetcher = makeEventFetcher([]);
    const { detector } = makeDetector({
      fetcher,
      metrics,
      gapPauseThreshold: 0,
      backfillMaxLedgers: 10,
    });

    const result = await detector.runBackfill(100, 200);

    expect(result.backfilledLedgers).toBe(10);
    expect(result.paused).toBe(false);
    expect(fetcher.fetchByLedgerWindow).toHaveBeenCalledWith({
      startLedger: 100,
      endLedger: 109,
    });
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenCalledWith(
      "completed"
    );
  });
});
