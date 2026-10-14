/**
 * Focused contract tests for `BackfillResult.pausedReason` and `correlationId`
 * (#1400).
 *
 * Asserts that:
 *   - Every non-completed stop path of `runBackfill` returns the exact
 *     `pausedReason` value documented in `GapBackfillPauseReason`.
 *   - The completed (non-paused) path omits `pausedReason`.
 *   - Every returned `BackfillResult` carries a non-empty `correlationId`.
 *
 * Each test drives `GapDetector.runBackfill` with minimal fake implementations
 * of `EventFetcher`, `BatchWriter`, and `InternalIndexerMetricsService` to
 * trigger exactly one stop condition at a time.
 *
 * All parser mocks are hoisted to the top level (vitest requirement).  The
 * trade-parser stub turns one event into one record so `records.length > 0`
 * and the batch writer is actually exercised in the dependency_unavailable
 * test.  The remaining parsers return empty arrays to keep other tests simple.
 */

import { describe, it, expect, vi } from "vitest";
import { GapDetector } from "./gapDetector.js";
import { BatchWriteError } from "./batchWriterError.js";
import type { EventFetcher } from "./eventFetcher.js";
import type { BatchWriter } from "./batchWriter.js";
import type { InternalIndexerMetricsService } from "./metrics.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";

// ---------------------------------------------------------------------------
// Module-level parser mocks (hoisted by vitest before any imports resolve)
// ---------------------------------------------------------------------------

vi.mock("./tradeParser.js", () => ({
  parseTradeEvents: (events: Array<{ ledger: number }>) => ({
    trades: events.map((e) => ({
      eventId: `${String(e.ledger).padStart(10, "0")}-0000000001-0000000000`,
      ledger: e.ledger,
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

vi.mock("./resolutionParser.js", () => ({
  parseResolutionEvents: () => ({ resolutions: [], errors: [] }),
}));

vi.mock("./collateralDepositedParser.js", () => ({
  parseCollateralDepositedEvents: () => ({ deposits: [], errors: [] }),
}));

vi.mock("./marketCreatedParser.js", () => ({
  parseMarketCreatedEvents: () => ({ markets: [], errors: [] }),
}));

// ---------------------------------------------------------------------------
// Fake helpers
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

/**
 * Builds a `GapDetector` with sane defaults. Any dependency can be overridden
 * through `overrides` so each test only supplies what it needs to trigger the
 * condition under test.
 */
function makeDetector(
  overrides: {
    gapPauseThreshold?: number;
    backfillMaxLedgers?: number;
    backfillEnabled?: boolean;
    fetcher?: EventFetcher;
    writer?: BatchWriter;
    metrics?: InternalIndexerMetricsService;
    logger?: ILogger;
  } = {}
) {
  const fetcher = overrides.fetcher ?? makeEventFetcher();
  const writer = overrides.writer ?? makeBatchWriter();
  const metrics = overrides.metrics ?? makeMetrics();
  const logger = overrides.logger ?? makeLogger();

  const detector = new GapDetector(
    {
      gapPauseThreshold: overrides.gapPauseThreshold ?? 1000,
      backfillMaxLedgers: overrides.backfillMaxLedgers ?? 500,
      contractId: "CTEST",
      backfillEnabled: overrides.backfillEnabled,
    },
    fetcher,
    writer,
    metrics,
    logger
  );

  return { detector, fetcher, writer, metrics, logger };
}

// ---------------------------------------------------------------------------
// Pause-reason contract — one test per stop path
// ---------------------------------------------------------------------------

describe("runBackfill pause-reason contract (#1400)", () => {
  // ── Stop path 1: gap ≥ gapPauseThreshold ─────────────────────────────────
  it('returns pausedReason "threshold" and a non-empty correlationId when the gap meets the fail-closed threshold', async () => {
    const { detector, fetcher } = makeDetector({ gapPauseThreshold: 50 });

    // gap size = 51 (100..150 inclusive) → meets threshold of 50
    const result = await detector.runBackfill(100, 150);

    expect(result.paused).toBe(true);
    expect(result.pausedReason).toBe("threshold");
    expect(result.correlationId).toBeTruthy();
    expect(typeof result.correlationId).toBe("string");
    expect(result.correlationId.length).toBeGreaterThan(0);
    // No fetch must ever be issued when pausing at the threshold
    expect(fetcher.fetchByLedgerWindow).not.toHaveBeenCalled();
  });

  // ── Stop path 2: kill-switch disabled ────────────────────────────────────
  it('returns pausedReason "disabled" and a non-empty correlationId when the kill-switch is off', async () => {
    const { detector, fetcher, writer } = makeDetector({
      backfillEnabled: false,
    });

    const result = await detector.runBackfill(100, 110);

    expect(result.paused).toBe(true);
    expect(result.pausedReason).toBe("disabled");
    expect(result.correlationId).toBeTruthy();
    expect(typeof result.correlationId).toBe("string");
    expect(result.correlationId.length).toBeGreaterThan(0);
    // Fail-closed: no fetch or write must occur
    expect(fetcher.fetchByLedgerWindow).not.toHaveBeenCalled();
    expect(writer.write).not.toHaveBeenCalled();
  });

  // ── Stop path 3: concurrent run already in flight ────────────────────────
  it('returns pausedReason "in_progress" and a non-empty correlationId when a concurrent run is already in flight', async () => {
    // Hold the first run open so the detector's in-flight flag is set
    let releaseFirstRun!: (v: unknown) => void;
    const firstRunPending = new Promise((resolve) => {
      releaseFirstRun = resolve;
    });

    const suspendedFetcher = {
      fetchByLedgerWindow: vi.fn().mockReturnValue(firstRunPending),
      getLatestLedgerInfo: vi.fn(),
    } as unknown as EventFetcher;

    const { detector } = makeDetector({ fetcher: suspendedFetcher });

    // First run starts but does not finish yet
    const firstRun = detector.runBackfill(100, 110);

    // Second run is attempted while the first is still in flight
    const secondResult = await detector.runBackfill(100, 110);

    expect(secondResult.paused).toBe(true);
    expect(secondResult.pausedReason).toBe("in_progress");
    expect(secondResult.correlationId).toBeTruthy();
    expect(typeof secondResult.correlationId).toBe("string");
    expect(secondResult.correlationId.length).toBeGreaterThan(0);
    // Only one fetch was ever dispatched
    expect(suspendedFetcher.fetchByLedgerWindow).toHaveBeenCalledTimes(1);

    // Unblock first run so we don't leak open promises
    releaseFirstRun({ events: [], latestLedger: 1000 });
    await firstRun;
  });

  // ── Stop path 4: batch write dependency outage ────────────────────────────
  it('returns pausedReason "dependency_unavailable" and a non-empty correlationId when the batch write fails with a dependency outage', async () => {
    // The mocked trade parser (top of file) turns one event into one record so
    // `records.length > 0` and the writer is actually called.
    const fetcher = makeEventFetcher([{ ledger: 101 }]);
    const writer = makeBatchWriter();
    writer.write = vi.fn().mockRejectedValue(
      new BatchWriteError(
        "BATCH_WRITE_DEPENDENCY_UNAVAILABLE",
        "DB unreachable",
        "bw_corr_test"
      )
    );
    const { detector, metrics } = makeDetector({ fetcher, writer });

    const result = await detector.runBackfill(100, 110);

    expect(result.paused).toBe(true);
    expect(result.pausedReason).toBe("dependency_unavailable");
    expect(result.correlationId).toBeTruthy();
    expect(typeof result.correlationId).toBe("string");
    expect(result.correlationId.length).toBeGreaterThan(0);
    expect(metrics.incrementGapBackfillOutcome).toHaveBeenCalledWith(
      "dependency_unavailable"
    );
    // Backfill ledgers must NOT be credited for a failed run
    expect(metrics.incrementBackfillLedgers).not.toHaveBeenCalled();
  });

  // ── Happy path: completed run ─────────────────────────────────────────────
  it("omits pausedReason and returns a non-empty correlationId on a completed (non-paused) run", async () => {
    const { detector } = makeDetector({
      gapPauseThreshold: 0, // disable threshold so a small gap completes
      backfillEnabled: true,
    });

    const result = await detector.runBackfill(100, 110);

    expect(result.paused).toBe(false);
    // pausedReason must be absent — not undefined masquerading as a key
    expect("pausedReason" in result).toBe(false);
    expect(result.correlationId).toBeTruthy();
    expect(typeof result.correlationId).toBe("string");
    expect(result.correlationId.length).toBeGreaterThan(0);
    expect(result.backfilledLedgers).toBe(11);
  });
});
