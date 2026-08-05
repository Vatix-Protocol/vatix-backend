/**
 * Gap detection + backfill integration fixture test.
 *
 * Tests the full PollingIngestionLoop pipeline with an artificially injected
 * ledger gap. The gap detector fires when the metrics high-water mark
 * (latestIndexedLedgerSequence) is not contiguous with the next batch start.
 *
 * This covers real-world scenarios where:
 *   - The cursor was manually advanced in the DB, skipping ledgers.
 *   - A prior tick crash left a hole between the confirmed indexed ledger
 *     and the cursor checkpoint.
 *   - The indexer was paused while the chain advanced, then restarted with
 *     a cursor pointing ahead of the last confirmed write.
 *
 * Verified behaviours:
 *
 *   1. The gap is detected within one poll cycle after the tip advances.
 *   2. The backfill re-fetches and persists the missing ledger's events.
 *   3. Idempotency holds: re-running the same ingest cycle skips all
 *      already-persisted events (skipped > 0, written = 0 on second pass).
 *   4. The gap_detected_total and backfill_ledgers_total metrics increment.
 *   5. The fail-closed threshold pauses the loop on an oversized gap.
 *
 * No database or RPC connection is used; all deps are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PollingIngestionLoop } from "./ingestion.js";
import type { EventFetcher } from "./eventFetcher.js";
import type { BatchWriter, BatchWriteResult } from "./batchWriter.js";
import type { CursorStorageClient } from "./storage.js";
import { InternalIndexerMetricsService } from "./metrics.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";
import type { RawChainEvent } from "./types.js";
import { nativeToScVal } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Event fixtures
// ---------------------------------------------------------------------------

const TRADE_TOPIC = "AAAADwAAAA50cmFkZV9leGVjdXRlZAAA";

function makeTradeEvent(id: string, ledger: number): RawChainEvent {
  const valueXdr = nativeToScVal({
    market_id: "market-gap-test",
    trader: "GTRADER",
    counterparty: "GCOUNTER",
    direction: "buy",
    outcome: "YES",
    price: 5_000_000n,
    quantity: 10n,
    buy_order_id: `buy-${id}`,
    sell_order_id: `sell-${id}`,
  }).toXDR("base64");

  return {
    id,
    ledger,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: "CTEST",
    type: "contract",
    pagingToken: `token-${id}`,
    valueXdr,
    topicsXdr: [TRADE_TOPIC],
  };
}

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

function makeStorage(): CursorStorageClient {
  return {
    loadCursor: vi.fn().mockResolvedValue(null),
    saveCursor: vi.fn().mockResolvedValue(undefined),
    loadLedgerHash: vi.fn().mockResolvedValue(null),
    saveLedgerHash: vi.fn().mockResolvedValue(undefined),
  };
}

async function runIngest(
  loop: PollingIngestionLoop,
  cursor: string | null
): Promise<{
  nextCursor: string;
  lastIndexedLedgerSequence: number;
  batchWriteSucceeded: boolean;
}> {
  return (
    loop as unknown as {
      ingestFromCursor(c: string | null): Promise<{
        nextCursor: string;
        lastIndexedLedgerSequence: number;
        batchWriteSucceeded: boolean;
      }>;
    }
  ).ingestFromCursor(cursor);
}

// ---------------------------------------------------------------------------
// Fixture: cursor jumped, skipping ledgers 51–100
//
// State machine:
//   - metrics.latestIndexedLedgerSequence = 50  (last confirmed write)
//   - ingestFromCursor("100") → startLedger = 101
//   - detectCursorGap(50, 101, 300) → gap [51, 100] (50 ledgers)
//   - Backfill fetches [51, 100], persists trade at ledger 51
//   - Normal batch fetches [101, 200], persists trade at ledger 101
// ---------------------------------------------------------------------------

describe("Gap detection fixture — cursor jumped past unprocessed ledgers", () => {
  let logger: ILogger;
  let storage: CursorStorageClient;
  let metrics: InternalIndexerMetricsService;
  let eventFetcher: EventFetcher;
  let batchWriter: BatchWriter;

  const writtenKeys = new Set<string>();

  beforeEach(() => {
    logger = makeLogger();
    storage = makeStorage();
    metrics = new InternalIndexerMetricsService();
    // Seed the high-water mark to ledger 50
    metrics.setLatestIndexedLedgerSequence(50);
    writtenKeys.clear();

    // Every fetch returns one trade event at the startLedger
    eventFetcher = {
      fetchByLedgerWindow: vi
        .fn()
        .mockImplementation(
          async ({ startLedger }: { startLedger: number }) => ({
            events: [makeTradeEvent(`evt-${startLedger}`, startLedger)],
            latestLedger: 300,
          })
        ),
      getLatestLedgerInfo: vi.fn().mockResolvedValue({
        sequence: 300,
        hash: "abc123",
      }),
    } as unknown as EventFetcher;

    // Idempotent writer
    batchWriter = {
      write: vi.fn().mockImplementation(async (records) => {
        let written = 0;
        let skipped = 0;
        for (const record of records) {
          const key = record.data.idempotencyKey as string;
          if (writtenKeys.has(key)) {
            skipped++;
          } else {
            writtenKeys.add(key);
            written++;
          }
        }
        return { written, skipped, errors: [] } satisfies BatchWriteResult;
      }),
      flush: vi.fn().mockResolvedValue(undefined),
    };
  });

  function createLoop(gapPauseThreshold = 0, backfillMaxLedgers = 500) {
    return new PollingIngestionLoop(logger, storage, metrics, 5_000, 10, {
      eventFetcher,
      batchWriter,
      contractId: "CTEST",
      ledgerWindowSize: 100,
      gapPauseThreshold,
      backfillMaxLedgers,
    });
  }

  it("detects the cursor jump within one poll cycle after tip advances", async () => {
    const loop = createLoop();
    // metrics high-water = 50; ingestFromCursor("100") → startLedger = 101
    // gap = [51, 100]
    await runIngest(loop, "100");

    expect(logger.warn).toHaveBeenCalledWith(
      "Cursor-level ledger gap detected — starting backfill",
      expect.objectContaining({
        event: "indexer.gap.cursor_gap",
        lastIndexedLedger: 50,
        gapStartLedger: 51,
        gapEndLedger: 100,
        gapSize: 50,
      })
    );
  });

  it("backfill re-fetches events for the skipped ledger range [51, 100]", async () => {
    const loop = createLoop();
    await runIngest(loop, "100");

    expect(eventFetcher.fetchByLedgerWindow).toHaveBeenCalledTimes(2);

    const calls = vi.mocked(eventFetcher.fetchByLedgerWindow).mock.calls;
    // First call = backfill
    expect(calls[0][0]).toEqual({ startLedger: 51, endLedger: 100 });
    // Second call = normal batch
    expect(calls[1][0]).toMatchObject({ startLedger: 101 });
  });

  it("backfill persists the missing event (written > 0 on first pass)", async () => {
    const loop = createLoop();
    await runIngest(loop, "100");

    expect(writtenKeys.size).toBeGreaterThan(0);
    // The event from the backfill range should be stored
    const backfillKey = [...writtenKeys].find((k) => k.includes("evt-51"));
    expect(backfillKey).toBeDefined();
  });

  it("backfill is idempotent: second pass writes nothing new", async () => {
    const loop = createLoop();

    // First pass: backfill + normal batch
    await runIngest(loop, "100");
    const keysAfterFirstPass = new Set(writtenKeys);

    // Second pass: same cursor, same high-water mark (not advanced by runIngest)
    await runIngest(loop, "100");

    expect(writtenKeys.size).toBe(keysAfterFirstPass.size);

    // All write() calls in the second pass should return written=0
    const allResults = vi.mocked(batchWriter.write).mock.results;
    const secondPassResults = allResults.slice(2); // skip first 2 (from first pass)
    for (const result of secondPassResults) {
      const r = (await result.value) as BatchWriteResult;
      expect(r.written).toBe(0);
      expect(r.skipped).toBeGreaterThan(0);
    }
  });

  it("increments gap_detected_total to 1", async () => {
    const loop = createLoop();
    await runIngest(loop, "100");
    expect(metrics.getGapDetectedTotal()).toBe(1);
  });

  it("increments backfill_ledgers_total by gap size (50)", async () => {
    const loop = createLoop();
    await runIngest(loop, "100");
    expect(metrics.getBackfillLedgersTotal()).toBe(50);
  });

  it("fail-closed: pauses when gap meets gapPauseThreshold", async () => {
    // threshold = 10, gap = 50 → pause
    const loop = createLoop(10);
    const result = await runIngest(loop, "100");

    expect(result.batchWriteSucceeded).toBe(false);
    expect((loop as unknown as { isPaused: boolean }).isPaused).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      "Ledger gap exceeds fail-closed threshold — pausing ingestion loop",
      expect.objectContaining({
        event: "indexer.gap.pause",
        gapSize: 50,
        gapPauseThreshold: 10,
      })
    );
  });

  it("fail-closed: subsequent ticks are skipped", async () => {
    const loop = createLoop(10);
    await runIngest(loop, "100");

    vi.mocked(eventFetcher.fetchByLedgerWindow).mockClear();
    await (loop as unknown as { tick(): Promise<void> }).tick();

    expect(eventFetcher.fetchByLedgerWindow).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "Ingestion loop is paused (gap threshold exceeded) — skipping tick",
      expect.objectContaining({ event: "indexer.gap.paused" })
    );
  });

  it("no gap is reported when high-water mark is contiguous with startLedger", async () => {
    // high-water = 50; ingestFromCursor("50") → startLedger = 51 = 50+1 ✓
    const loop = createLoop();
    await runIngest(loop, "50");

    const warnCalls = vi.mocked(logger.warn).mock.calls;
    const gapWarns = warnCalls.filter((c) =>
      String(c[0]).includes("gap detected")
    );
    expect(gapWarns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Documents that detectGap() is available for explicit within-window use
// ---------------------------------------------------------------------------

describe("GapDetector.detectGap — explicit within-window verification API", () => {
  it("is available for explicit caller use (documents the API surface)", async () => {
    const { GapDetector } = await import("./gapDetector.js");

    const fakeLogger: ILogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as ILogger;

    const fakeMetrics = {
      incrementGapDetected: vi.fn(),
      incrementBackfillLedgers: vi.fn(),
    } as unknown as InternalIndexerMetricsService;

    const detector = new GapDetector(
      { gapPauseThreshold: 0, backfillMaxLedgers: 100, contractId: "C" },
      { fetchByLedgerWindow: vi.fn() } as unknown as EventFetcher,
      { write: vi.fn(), flush: vi.fn() } as unknown as BatchWriter,
      fakeMetrics,
      fakeLogger
    );

    // Ledger 102 explicitly missing from a known-dense event set
    const seen = new Set([100, 101, 103]);
    const result = detector.detectGap(100, 103, 200, seen);

    expect(result.gapDetected).toBe(true);
    expect(result.gapStartLedger).toBe(102);
  });
});
