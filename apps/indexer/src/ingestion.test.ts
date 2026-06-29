import { describe, it, expect, vi, beforeEach } from "vitest";
import { PollingIngestionLoop } from "./ingestion.js";
import type { EventFetcher } from "./eventFetcher.js";
import type { BatchWriter } from "./batchWriter.js";
import type { CursorStorageClient } from "./storage.js";
import type { InternalIndexerMetricsService } from "./metrics.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";
import type { RawChainEvent } from "./types.js";
import { nativeToScVal } from "@stellar/stellar-sdk";

const TRADE_TOPIC = "AAAADwAAABR0cmFkZV9leGVjdXRlZF9ldmVudA==";
const RESOLUTION_TOPIC = "AAAADwAAAA9tYXJrZXRfcmVzb2x2ZWQA";

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
    valueXdr,
    topicsXdr: [RESOLUTION_TOPIC],
  };
}

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
    };
    metrics = {
      setLatestIndexedLedgerSequence: vi.fn(),
      getLatestIndexedLedgerSequence: vi.fn().mockReturnValue(10),
      toLogFields: vi.fn().mockReturnValue({}),
    } as unknown as InternalIndexerMetricsService;
    eventFetcher = {
      fetchByLedgerWindow: vi.fn(),
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

    const loop = createLoop(2);
    (loop as unknown as { cursor: string | null }).cursor = "0";

    await (loop as unknown as { tick(): Promise<void> }).tick();
    expect(storage.saveCursor).not.toHaveBeenCalled();

    await (loop as unknown as { tick(): Promise<void> }).tick();
    expect(storage.saveCursor).toHaveBeenCalledTimes(1);
    expect(storage.saveCursor).toHaveBeenCalledWith("200");
  });
});
