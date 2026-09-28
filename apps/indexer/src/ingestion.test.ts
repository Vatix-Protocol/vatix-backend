import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PollingIngestionLoop } from "./ingestion.js";
import type { EventFetcher } from "./eventFetcher.js";
import type { BatchWriter } from "./batchWriter.js";
import type { CursorStorageClient } from "./storage.js";
import type { InternalIndexerMetricsService } from "./metrics.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";
import type { RawChainEvent } from "./types.js";
import { nativeToScVal } from "@stellar/stellar-sdk";

const TRADE_TOPIC = "AAAADwAAABR0cmFkZV9leGVjdXRlZF9ldmVudA==";
const RESOLUTION_TOPIC = "AAAADwAAABVtYXJrZXRfcmVzb2x2ZWRfZXZlbnQAAAA=";

function makeTradeEvent(id: string): RawChainEvent {
  const valueXdr = nativeToScVal({
    market_id: "market-1",
    trader: "GTRADER",
    counterparty: "GCOUNTER",
    direction: "buy",
    outcome: "YES",
    price: 5_000_000n,
    quantity: 10n,
    buy_order_id: "buy-1",
    sell_order_id: "sell-1",
  }).toXDR("base64");

  return {
    id,
    ledger: 50,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: "CTEST",
    type: "contract",
    pagingToken: `token-${id}`,
    eventIndex: 0,
    valueXdr,
    topicsXdr: [TRADE_TOPIC],
  };
}

function makeResolutionEvent(id: string): RawChainEvent {
  const valueXdr = nativeToScVal({
    market_id: "market-1",
    outcome: "YES",
    oracle: "GORACLE",
  }).toXDR("base64");

  return {
    id,
    ledger: 51,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: "CTEST",
    type: "contract",
    pagingToken: `token-${id}`,
    eventIndex: 0,
    valueXdr,
    topicsXdr: [RESOLUTION_TOPIC],
  };
}

function makeForkResolutionEvent(
  id: string,
  ledger: number,
  oracle: string
): RawChainEvent {
  const valueXdr = nativeToScVal({
    market_id: "market-1",
    outcome: "YES",
    oracle,
  }).toXDR("base64");

  return {
    id,
    ledger,
    ledgerClosedAt: "2024-01-01T00:00:00Z",
    contractId: "CTEST",
    type: "contract",
    pagingToken: `token-${id}`,
    eventIndex: 0,
    valueXdr,
    topicsXdr: [RESOLUTION_TOPIC],
  };
}

/**
 * Synthetic reorg fixture: two competing chain forks that report the same
 * latest ledger sequence but a different ledger hash and a different
 * resolution event for the same market/ledger. Used to exercise the
 * hash-mismatch reorg branch (as opposed to a sequence regression) and to
 * verify that the canonical fork's events are the ones re-ingested after the
 * cursor rewinds.
 */
const SYNTHETIC_REORG_FIXTURE = {
  forkA: {
    hash: "hash-fork-a",
    latestLedger: 100,
    events: [
      makeForkResolutionEvent(
        "0000000050-0000000001-0000000000",
        50,
        "GORACLE_FORK_A"
      ),
    ],
  },
  forkB: {
    hash: "hash-fork-b",
    latestLedger: 100,
    events: [
      makeForkResolutionEvent(
        "0000000050-0000000002-0000000000",
        50,
        "GORACLE_FORK_B"
      ),
    ],
  },
};

function makeLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    }),
  };
}

describe("PollingIngestionLoop", () => {
  let logger: ILogger;
  let storage: CursorStorageClient;
  let metrics: InternalIndexerMetricsService;
  let eventFetcher: EventFetcher;
  let batchWriter: BatchWriter;

  beforeEach(() => {
    logger = makeLogger();
    storage = {
      loadCursor: vi.fn().mockResolvedValue("10"),
      saveCursor: vi.fn().mockResolvedValue(undefined),
      loadLedgerHash: vi.fn().mockResolvedValue(null),
      saveLedgerHash: vi.fn().mockResolvedValue(undefined),
    };
    metrics = {
      setLatestIndexedLedgerSequence: vi.fn(),
      getLatestIndexedLedgerSequence: vi.fn().mockReturnValue(10),
      setLatestNetworkLedgerSequence: vi.fn(),
      getLatestNetworkLedgerSequence: vi.fn().mockReturnValue(200),
      getLag: vi.fn().mockReturnValue(190),
      toLogFields: vi.fn().mockReturnValue({}),
      incrementParseError: vi.fn(),
      incrementIngestionFailure: vi.fn(),
      resetIngestionFailures: vi.fn(),
    } as unknown as InternalIndexerMetricsService;
    eventFetcher = {
      fetchByLedgerWindow: vi.fn(),
      getLatestLedgerInfo: vi
        .fn()
        .mockResolvedValue({ sequence: 200, hash: "abcd1234" }),
    } as unknown as EventFetcher;
    batchWriter = {
      write: vi.fn().mockResolvedValue({ written: 2, skipped: 0, errors: [] }),
      flush: vi.fn().mockResolvedValue(undefined),
    };
  });

  function createLoop(checkpointEvery = 10) {
    return new PollingIngestionLoop(
      logger,
      storage,
      metrics,
      5_000,
      checkpointEvery,
      {
        eventFetcher,
        batchWriter,
        contractId: "CTEST",
        ledgerWindowSize: 100,
      }
    );
  }

  async function runIngest(loop: PollingIngestionLoop, cursor: string | null) {
    return (
      loop as unknown as {
        ingestFromCursor(c: string | null): Promise<{
          nextCursor: string;
          lastIndexedLedgerSequence: number;
        }>;
      }
    ).ingestFromCursor(cursor);
  }

  it("happy path: fetches window, writes batch, advances cursor", async () => {
    vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValue({
      events: [
        makeTradeEvent("0000000050-0000000001-0000000000"),
        makeResolutionEvent("0000000051-0000000001-0000000000"),
      ],
      latestLedger: 200,
    });

    const loop = createLoop();
    const result = await runIngest(loop, "10");

    expect(eventFetcher.fetchByLedgerWindow).toHaveBeenCalledWith({
      startLedger: 11,
      endLedger: 110,
    });
    expect(batchWriter.write).toHaveBeenCalledTimes(1);
    expect(batchWriter.write).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ kind: "trade" }),
        expect.objectContaining({ kind: "resolution" }),
      ])
    );
    expect(result.nextCursor).toBe("110");
    expect(result.lastIndexedLedgerSequence).toBe(110);
  });

  it("RPC failure: tick logs error and does not advance cursor", async () => {
    vi.mocked(eventFetcher.fetchByLedgerWindow).mockRejectedValue(
      new Error("rpc unavailable")
    );

    const loop = createLoop();
    (loop as unknown as { cursor: string | null }).cursor = "10";

    await (loop as unknown as { tick(): Promise<void> }).tick();

    expect(logger.error).toHaveBeenCalledWith(
      "Ingestion tick failed",
      expect.objectContaining({ error: "rpc unavailable" })
    );
    expect(storage.saveCursor).not.toHaveBeenCalled();
    expect((loop as unknown as { cursor: string | null }).cursor).toBe("10");
  });

  it("parse failure isolation: one bad trade and one good resolution", async () => {
    const badTrade = makeTradeEvent("0000000050-0000000001-0000000001");
    badTrade.valueXdr = nativeToScVal({ market_id: "only-field" }).toXDR(
      "base64"
    );

    vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValue({
      events: [
        badTrade,
        makeResolutionEvent("0000000051-0000000001-0000000000"),
      ],
      latestLedger: 200,
    });
    vi.mocked(batchWriter.write).mockResolvedValue({
      written: 1,
      skipped: 0,
      errors: [],
    });

    const loop = createLoop();
    await runIngest(loop, "10");

    expect(logger.warn).toHaveBeenCalledWith(
      "Trade parse error — skipping event",
      expect.objectContaining({
        eventId: "0000000050-0000000001-0000000001",
      })
    );
    expect(batchWriter.write).toHaveBeenCalledWith([
      expect.objectContaining({ kind: "resolution" }),
    ]);
  });

  it("checkpoint gating: persists cursor only after N successful batches", async () => {
    vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValue({
      events: [],
      latestLedger: 500,
    });
    vi.mocked(metrics.getLatestIndexedLedgerSequence).mockReturnValue(0);

    const loop = createLoop(2);
    (loop as unknown as { cursor: string | null }).cursor = "0";

    await (loop as unknown as { tick(): Promise<void> }).tick();
    expect(storage.saveCursor).not.toHaveBeenCalled();

    await (loop as unknown as { tick(): Promise<void> }).tick();
    expect(storage.saveCursor).toHaveBeenCalledTimes(1);
    expect(storage.saveCursor).toHaveBeenCalledWith("200");
  });

  it("ledger window size bounds check: < 1 returns early with error log (Issue #711)", async () => {
    const loop = new PollingIngestionLoop(logger, storage, metrics, 5_000, 10, {
      eventFetcher,
      batchWriter,
      contractId: "CTEST",
      ledgerWindowSize: 0,
    });
    const result = await runIngest(loop, "10");
    expect(logger.error).toHaveBeenCalledWith(
      "Invalid ledgerWindowSize — must be >= 1",
      expect.objectContaining({ ledgerWindowSize: 0 })
    );
    expect(result.nextCursor).toBe("10");
    expect(result.lastIndexedLedgerSequence).toBe(10);
    expect(eventFetcher.fetchByLedgerWindow).not.toHaveBeenCalled();
  });

  it("records latest network ledger sequence for lag metrics (Issue #713)", async () => {
    vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValue({
      events: [],
      latestLedger: 300,
    });

    const loop = createLoop();
    await runIngest(loop, "10");

    expect(metrics.setLatestNetworkLedgerSequence).toHaveBeenCalledWith(300);
  });

  it("unknown event type logs warning without stalling (Issue #712)", async () => {
    const unknownEvent: RawChainEvent = {
      id: "0000000050-0000000002-0000000000",
      ledger: 50,
      ledgerClosedAt: "2024-01-01T00:00:00Z",
      contractId: "CTEST",
      type: "contract",
      pagingToken: "token-unknown",
      valueXdr: "AAAAAA==",
      topicsXdr: ["AAAAEwAAAA91bmtub3duX3RvcGljAAAA"],
    };

    vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValue({
      events: [unknownEvent],
      latestLedger: 200,
    });

    const loop = createLoop();
    await runIngest(loop, "10");

    expect(logger.warn).toHaveBeenCalledWith(
      "Unknown event type — no matching parser found",
      expect.objectContaining({
        eventId: "0000000050-0000000002-0000000000",
        ledger: 50,
      })
    );
  });

  it("graceful shutdown: stop() awaits active tick and flushes cursor", async () => {
    let tickResolve: (val: any) => void = () => {};
    const tickPromise = new Promise((resolve) => {
      tickResolve = resolve;
    });

    vi.mocked(eventFetcher.fetchByLedgerWindow).mockImplementation(async () => {
      await tickPromise;
      return {
        events: [],
        latestLedger: 300,
      };
    });

    const loop = createLoop(2);
    (loop as unknown as { cursor: string | null }).cursor = "10";

    const tickCall = (loop as unknown as { tick(): Promise<void> }).tick();
    const stopCall = loop.stop();

    let stopResolved = false;
    stopCall.then(() => {
      stopResolved = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(stopResolved).toBe(false);

    tickResolve(null);

    await tickCall;
    await stopCall;

    expect(stopResolved).toBe(true);
    expect(storage.saveCursor).toHaveBeenCalledWith("110");
  });
});

// ---------------------------------------------------------------------------
// Stale / corrupted cursor detection (reliability pass 040)
// ---------------------------------------------------------------------------
describe("PollingIngestionLoop — stale cursor handling", () => {
  let logger: ILogger;
  let storage: CursorStorageClient;
  let metrics: InternalIndexerMetricsService;
  let eventFetcher: EventFetcher;
  let batchWriter: BatchWriter;

  beforeEach(() => {
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnValue({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      }),
    };
    storage = {
      loadCursor: vi.fn().mockResolvedValue(null),
      saveCursor: vi.fn().mockResolvedValue(undefined),
      loadLedgerHash: vi.fn().mockResolvedValue(null),
      saveLedgerHash: vi.fn().mockResolvedValue(undefined),
    };
    metrics = {
      setLatestIndexedLedgerSequence: vi.fn(),
      getLatestIndexedLedgerSequence: vi.fn().mockReturnValue(0),
      setLatestNetworkLedgerSequence: vi.fn(),
      getLatestNetworkLedgerSequence: vi.fn().mockReturnValue(100),
      getLag: vi.fn().mockReturnValue(100),
      toLogFields: vi.fn().mockReturnValue({}),
      incrementIngestionFailure: vi.fn(),
      resetIngestionFailures: vi.fn(),
    } as unknown as InternalIndexerMetricsService;
    eventFetcher = {
      fetchByLedgerWindow: vi.fn().mockResolvedValue({
        events: [],
        latestLedger: 100,
      }),
      getLatestLedgerInfo: vi
        .fn()
        .mockResolvedValue({ sequence: 100, hash: "efgh5678" }),
    } as unknown as EventFetcher;
    batchWriter = {
      write: vi.fn().mockResolvedValue({ written: 0, skipped: 0, errors: [] }),
      flush: vi.fn().mockResolvedValue(undefined),
    };
  });

  function createLoop() {
    return new PollingIngestionLoop(logger, storage, metrics, 5_000, 10, {
      eventFetcher,
      batchWriter,
      contractId: "CTEST",
      ledgerWindowSize: 100,
    });
  }

  async function runIngest(loop: PollingIngestionLoop, cursor: string | null) {
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

  it("emits a warn log when cursor is a non-numeric string", async () => {
    const loop = createLoop();
    await runIngest(loop, "not-a-number");

    expect(logger.warn).toHaveBeenCalledWith(
      "Stale or corrupted cursor detected — resetting to ledger 0",
      expect.objectContaining({
        cursor: "not-a-number",
        action: "reset_to_zero",
      })
    );
  });

  it("emits a warn log when cursor is NaN (e.g. 'NaN')", async () => {
    const loop = createLoop();
    await runIngest(loop, "NaN");

    expect(logger.warn).toHaveBeenCalledWith(
      "Stale or corrupted cursor detected — resetting to ledger 0",
      expect.objectContaining({ cursor: "NaN" })
    );
  });

  it("does not emit a warn log for a valid numeric cursor", async () => {
    const loop = createLoop();
    await runIngest(loop, "42");

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const staleCursorWarns = warnCalls.filter((c) =>
      String(c[0]).includes("Stale or corrupted cursor")
    );
    expect(staleCursorWarns).toHaveLength(0);
  });

  it("does not emit a warn log for a null cursor (fresh start)", async () => {
    const loop = createLoop();
    await runIngest(loop, null);

    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const staleCursorWarns = warnCalls.filter((c) =>
      String(c[0]).includes("Stale or corrupted cursor")
    );
    expect(staleCursorWarns).toHaveLength(0);
  });

  it("uses ledger 0 as the safe start when cursor is corrupted", async () => {
    const loop = createLoop();
    await runIngest(loop, "garbage-cursor");

    // With safeCurrentSequence = 0, startLedger = 1
    expect(eventFetcher.fetchByLedgerWindow).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 1 })
    );
  });

  it("processes normally after recovering from a corrupted cursor", async () => {
    const loop = createLoop();
    const result = await runIngest(loop, "corrupt!cursor");

    // Should not throw — processing should complete
    expect(result).toBeDefined();
    expect(typeof result.nextCursor).toBe("string");
  });

  describe("reorg detection", () => {
    it("detects reorg when latest ledger sequence regresses", async () => {
      const loop = createLoop();

      // First tick establishes a baseline (latestLedger = 100)
      let result = await runIngest(loop, "50");
      expect(result.batchWriteSucceeded).toBe(true);

      // Second tick returns a lower latestLedger → reorg detected
      (
        eventFetcher.fetchByLedgerWindow as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        events: [],
        latestLedger: 80, // regressed from 100
      });

      result = await runIngest(loop, "50");
      expect(result.batchWriteSucceeded).toBe(false);
      expect(Number(result.nextCursor)).toBe(0); // rewound by 100 (windowSize 100 * 1)
      expect(logger.warn).toHaveBeenCalledWith(
        "Chain reorganisation detected — rewinding cursor",
        expect.objectContaining({
          event: "indexer.reorg.detected",
        })
      );
    });

    it("does not trigger reorg on normal progression", async () => {
      const loop = createLoop();

      await runIngest(loop, "50");

      // Normal: latestLedger increased
      (
        eventFetcher.fetchByLedgerWindow as ReturnType<typeof vi.fn>
      ).mockResolvedValue({
        events: [],
        latestLedger: 150,
      });

      const result = await runIngest(loop, "50");
      expect(result.batchWriteSucceeded).toBe(true);
      expect(logger.warn).not.toHaveBeenCalledWith(
        "Chain reorganisation detected — rewinding cursor",
        expect.anything()
      );
    });

    it("skips reorg detection on first tick (no baseline)", async () => {
      const loop = createLoop();

      const result = await runIngest(loop, null);
      expect(result.batchWriteSucceeded).toBe(true);
      expect(logger.warn).not.toHaveBeenCalledWith(
        "Chain reorganisation detected — rewinding cursor",
        expect.anything()
      );
    });

    describe("synthetic reorg fixture — cursor rewind", () => {
      const { forkA, forkB } = SYNTHETIC_REORG_FIXTURE;

      it("detects a same-sequence hash-mismatch reorg and rewinds the cursor", async () => {
        const loop = createLoop();

        // Tick 1: ingest fork A and establish the sequence+hash baseline.
        vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValueOnce({
          events: forkA.events,
          latestLedger: forkA.latestLedger,
        });
        vi.mocked(eventFetcher.getLatestLedgerInfo).mockResolvedValueOnce({
          sequence: forkA.latestLedger,
          hash: forkA.hash,
        });
        await (loop as unknown as { tick(): Promise<void> }).tick();

        expect(batchWriter.write).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "resolution",
              data: expect.objectContaining({
                oracleAddress: "GORACLE_FORK_A",
              }),
            }),
          ])
        );

        // Tick 2: the network now reports fork B — same sequence, different hash.
        vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValueOnce({
          events: forkB.events,
          latestLedger: forkB.latestLedger,
        });
        vi.mocked(eventFetcher.getLatestLedgerInfo).mockResolvedValueOnce({
          sequence: forkB.latestLedger,
          hash: forkB.hash,
        });
        await (loop as unknown as { tick(): Promise<void> }).tick();

        expect(logger.warn).toHaveBeenCalledWith(
          "Chain reorganisation detected — rewinding cursor",
          expect.objectContaining({ event: "indexer.reorg.detected" })
        );
        // Fork B was not written blindly — the reorg tick only rewinds.
        expect(batchWriter.write).toHaveBeenCalledTimes(1);

        const cursorAfterReorg = (loop as unknown as { cursor: string }).cursor;
        expect(Number(cursorAfterReorg)).toBeLessThan(forkA.latestLedger);
      });

      it("re-ingests the canonical fork's events once the cursor resumes past the rewind point", async () => {
        const loop = createLoop();

        vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValueOnce({
          events: forkA.events,
          latestLedger: forkA.latestLedger,
        });
        vi.mocked(eventFetcher.getLatestLedgerInfo).mockResolvedValueOnce({
          sequence: forkA.latestLedger,
          hash: forkA.hash,
        });
        await (loop as unknown as { tick(): Promise<void> }).tick();

        vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValueOnce({
          events: forkB.events,
          latestLedger: forkB.latestLedger,
        });
        vi.mocked(eventFetcher.getLatestLedgerInfo).mockResolvedValueOnce({
          sequence: forkB.latestLedger,
          hash: forkB.hash,
        });
        await (loop as unknown as { tick(): Promise<void> }).tick(); // reorg tick — rewinds only

        // Tick 3: the chain has since produced a new ledger on top of fork B
        // (its tip is now canonical), so the latest sequence advances past
        // the reorg point. Normal progression resumes from the rewound
        // cursor and re-fetches fork B's canonical event for ledger 50.
        vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValueOnce({
          events: forkB.events,
          latestLedger: forkB.latestLedger + 1,
        });
        vi.mocked(eventFetcher.getLatestLedgerInfo).mockResolvedValueOnce({
          sequence: forkB.latestLedger + 1,
          hash: "hash-fork-b-plus-one",
        });
        await (loop as unknown as { tick(): Promise<void> }).tick();

        // tick 1 + tick 3 wrote; the reorg tick (2) wrote nothing.
        expect(batchWriter.write).toHaveBeenCalledTimes(2);
        expect(batchWriter.write).toHaveBeenLastCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "resolution",
              data: expect.objectContaining({
                oracleAddress: "GORACLE_FORK_B",
              }),
            }),
          ])
        );
      });
    });
  });

  // ===========================================================================
  // #1127 - ingestion loop resilience
  // ===========================================================================
  describe("PollingIngestionLoop - resilience (#1127)", () => {
    let logger: ILogger;
    let storage: CursorStorageClient;
    let metrics: InternalIndexerMetricsService;
    let eventFetcher: EventFetcher;
    let batchWriter: BatchWriter;

    beforeEach(() => {
      vi.useRealTimers();
      logger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      } as unknown as ILogger;
      storage = {
        loadCursor: vi.fn().mockResolvedValue("10"),
        saveCursor: vi.fn().mockResolvedValue(undefined),
        loadLedgerHash: vi.fn().mockResolvedValue(null),
        saveLedgerHash: vi.fn().mockResolvedValue(undefined),
      } as unknown as CursorStorageClient;
      metrics = {
        setLatestIndexedLedgerSequence: vi.fn(),
        getLatestIndexedLedgerSequence: vi.fn().mockReturnValue(10),
        setLatestNetworkLedgerSequence: vi.fn(),
        getLatestNetworkLedgerSequence: vi.fn().mockReturnValue(200),
        getLag: vi.fn().mockReturnValue(190),
        toLogFields: vi.fn().mockReturnValue({}),
        incrementParseError: vi.fn(),
        incrementIngestionFailure: vi.fn(),
        resetIngestionFailures: vi.fn(),
      } as unknown as InternalIndexerMetricsService;
      eventFetcher = {
        fetchByLedgerWindow: vi
          .fn()
          .mockResolvedValue({ events: [], latestLedger: 200 }),
        getLatestLedgerInfo: vi
          .fn()
          .mockResolvedValue({ sequence: 200, hash: "abcd1234" }),
      } as unknown as EventFetcher;
      batchWriter = {
        write: vi
          .fn()
          .mockResolvedValue({ written: 0, skipped: 0, errors: [] }),
        flush: vi.fn().mockResolvedValue(undefined),
      } as unknown as BatchWriter;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function createLoop(
      intervalMs = 1_000,
      deps: Record<string, unknown> = {}
    ) {
      return new PollingIngestionLoop(logger, storage, metrics, intervalMs, 1, {
        eventFetcher,
        batchWriter,
        contractId: "CTEST",
        ledgerWindowSize: 100,
        ...deps,
      });
    }

    async function tick(loop: PollingIngestionLoop) {
      await (loop as unknown as { tick(): Promise<void> }).tick();
    }

    function delayOf(loop: PollingIngestionLoop) {
      return (
        loop as unknown as { nextTickDelayMs(): number }
      ).nextTickDelayMs();
    }

    it("doubles the retry delay on consecutive failures up to the configured ceiling", async () => {
      vi.mocked(eventFetcher.fetchByLedgerWindow).mockRejectedValue(
        new Error("rpc unavailable")
      );
      const loop = createLoop(1_000, { tickBackoffMaxMs: 8_000 });

      expect(delayOf(loop)).toBe(1_000);
      await tick(loop);
      expect(loop.getConsecutiveTickFailures()).toBe(1);
      expect(delayOf(loop)).toBe(2_000);
      await tick(loop);
      expect(loop.getConsecutiveTickFailures()).toBe(2);
      expect(delayOf(loop)).toBe(4_000);
      await tick(loop);
      expect(loop.getConsecutiveTickFailures()).toBe(3);
      expect(delayOf(loop)).toBe(8_000);
      await tick(loop);
      // Capped: the delay never grows past the configured ceiling.
      expect(loop.getConsecutiveTickFailures()).toBe(4);
      expect(delayOf(loop)).toBe(8_000);
    });

    it("returns to the base interval after a healthy tick", async () => {
      vi.mocked(eventFetcher.fetchByLedgerWindow)
        .mockRejectedValueOnce(new Error("rpc unavailable"))
        .mockResolvedValue({ events: [], latestLedger: 200 });
      const loop = createLoop(1_000, { tickBackoffMaxMs: 8_000 });

      await tick(loop);
      expect(loop.getConsecutiveTickFailures()).toBe(1);
      expect(delayOf(loop)).toBe(2_000);

      await tick(loop);
      expect(loop.getConsecutiveTickFailures()).toBe(0);
      expect(delayOf(loop)).toBe(1_000);
    });

    it("treats tickBackoffMaxMs=0 as the kill-switch and never backs off", async () => {
      vi.mocked(eventFetcher.fetchByLedgerWindow).mockRejectedValue(
        new Error("rpc unavailable")
      );
      const loop = createLoop(1_000, { tickBackoffMaxMs: 0 });

      await tick(loop);
      await tick(loop);
      expect(delayOf(loop)).toBe(1_000);
    });

    it("exports the failure streak to metrics and clears it on recovery", async () => {
      vi.mocked(eventFetcher.fetchByLedgerWindow)
        .mockRejectedValueOnce(new Error("rpc unavailable"))
        .mockResolvedValue({ events: [], latestLedger: 200 });
      const loop = createLoop(1_000, { tickBackoffMaxMs: 8_000 });

      await tick(loop);
      expect(metrics.incrementIngestionFailure).toHaveBeenCalledWith(1);
      expect(metrics.resetIngestionFailures).not.toHaveBeenCalled();

      await tick(loop);
      expect(metrics.resetIngestionFailures).toHaveBeenCalled();
    });

    it("does not advance the cursor when a tick fails", async () => {
      vi.mocked(eventFetcher.fetchByLedgerWindow).mockRejectedValue(
        new Error("rpc unavailable")
      );
      const loop = createLoop(1_000, { tickBackoffMaxMs: 8_000 });
      (loop as unknown as { cursor: string | null }).cursor = "10";

      await tick(loop);

      expect((loop as unknown as { cursor: string | null }).cursor).toBe("10");
      expect(storage.saveCursor).not.toHaveBeenCalled();
    });

    it("keeps a failing checkpoint out of the failure streak so the next tick retries it", async () => {
      vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValue({
        events: [],
        latestLedger: 200,
      });
      vi.mocked(storage.saveCursor).mockRejectedValue(new Error("db down"));

      const loop = createLoop(1_000, { tickBackoffMaxMs: 8_000 });
      (loop as unknown as { cursor: string | null }).cursor = "10";

      await tick(loop);

      // The batch advanced the in-memory cursor...
      expect((loop as unknown as { cursor: string | null }).cursor).toBe("110");
      // ...but persisting it failed, which is logged distinctly and does not
      // count as a processing failure (the batch itself was written).
      expect(logger.error).toHaveBeenCalledWith(
        "Checkpoint flush failed — will retry next tick",
        expect.objectContaining({
          event: "indexer.ingestion.checkpoint_failed",
        })
      );
      expect(loop.getConsecutiveTickFailures()).toBe(0);
    });

    it("ignores a duplicate start() instead of double-scheduling ticks", async () => {
      vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValue({
        events: [],
        latestLedger: 200,
      });
      const loop = createLoop(1_000, { tickBackoffMaxMs: 8_000 });

      await loop.start("10");
      const timerAfterFirstStart = (loop as unknown as { timer: unknown })
        .timer;
      await loop.start("10");

      expect(timerAfterFirstStart).not.toBeNull();
      expect((loop as unknown as { timer: unknown }).timer).toBe(
        timerAfterFirstStart
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "Ingestion loop already started — ignoring duplicate start()",
        expect.objectContaining({ event: "indexer.ingestion.duplicate_start" })
      );

      await loop.stop();
    });

    it("makes stop() idempotent so a second shutdown does not re-flush", async () => {
      vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValue({
        events: [],
        latestLedger: 200,
      });
      const loop = createLoop(1_000, { tickBackoffMaxMs: 8_000 });
      (loop as unknown as { cursor: string | null }).cursor = "10";

      await loop.stop();
      const callsAfterFirstStop = vi.mocked(storage.saveCursor).mock.calls
        .length;
      await loop.stop();

      expect(vi.mocked(storage.saveCursor).mock.calls.length).toBe(
        callsAfterFirstStop
      );
    });

    it("does not reject from stop() when the final checkpoint flush fails", async () => {
      vi.mocked(storage.saveCursor).mockRejectedValue(new Error("db down"));
      const loop = createLoop(1_000, { tickBackoffMaxMs: 8_000 });
      (loop as unknown as { cursor: string | null }).cursor = "10";

      await expect(loop.stop()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        "Final checkpoint flush failed on shutdown",
        expect.objectContaining({ phase: "shutdown" })
      );
    });

    it("does not leave the shutdown timeout timer pending after a clean drain", async () => {
      const clearSpy = vi.spyOn(globalThis, "clearTimeout");
      vi.mocked(eventFetcher.fetchByLedgerWindow).mockResolvedValue({
        events: [],
        latestLedger: 200,
      });
      const loop = createLoop(1_000, { tickBackoffMaxMs: 8_000 });
      (loop as unknown as { cursor: string | null }).cursor = "10";

      // Simulate an in-flight tick so stop() takes the timeout-racing path.
      (
        loop as unknown as { activeTickPromise: Promise<void> | null }
      ).activeTickPromise = Promise.resolve();

      await loop.stop();

      // The race installs a timeout; it must be cleared so a fast drain cannot
      // keep the process alive for the full shutdown budget.
      expect(clearSpy).toHaveBeenCalled();
      clearSpy.mockRestore();
    });
  });
});
