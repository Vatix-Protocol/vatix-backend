import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrismaBatchWriter } from "./batchWriter.js";
import { withIdempotencyKey } from "./idempotency.js";
import type { NormalizedTrade, NormalizedResolution } from "./types.js";

const TRADE: NormalizedTrade = {
  eventId: "0000000042-0000000001-0000000003",
  ledger: 42,
  ledgerClosedAt: "2024-06-01T00:00:00Z",
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
};

const RESOLUTION: NormalizedResolution = {
  eventId: "0000000099-0000000002-0000000000",
  ledger: 99,
  ledgerClosedAt: "2024-09-01T00:00:00Z",
  contractId: "CTEST",
  marketId: "market-xyz",
  outcome: "NO",
  oracleAddress: "GORACLE",
};

function createMockTx() {
  return {
    indexerProcessedEvent: {
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
    },
    indexedTrade: {
      create: vi.fn().mockResolvedValue({}),
    },
    resolutionCandidate: {
      create: vi.fn().mockResolvedValue({}),
    },
  };
}

const mockPrisma = {
  $transaction: vi.fn(),
};

vi.mock("../../../src/services/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

describe("PrismaBatchWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty result for empty batch", async () => {
    const writer = new PrismaBatchWriter();
    await expect(writer.write([])).resolves.toEqual({
      written: 0,
      skipped: 0,
      errors: [],
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("writes trade and resolution records in one transaction", async () => {
    const tx = createMockTx();
    tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const writer = new PrismaBatchWriter();
    const result = await writer.write([
      { kind: "trade", data: withIdempotencyKey(TRADE) },
      { kind: "resolution", data: withIdempotencyKey(RESOLUTION) },
    ]);

    expect(result).toEqual({ written: 2, skipped: 0, errors: [] });
    expect(tx.indexedTrade.create).toHaveBeenCalledTimes(1);
    expect(tx.resolutionCandidate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          marketId: "market-xyz",
          proposedOutcome: false,
          status: "PROPOSED",
          operatorAddress: "GORACLE",
        }),
      })
    );
  });

  it("skips duplicate replays", async () => {
    const tx = createMockTx();
    const persisted = withIdempotencyKey(TRADE);
    tx.indexerProcessedEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ idempotencyKey: persisted.idempotencyKey });
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const writer = new PrismaBatchWriter();
    const first = await writer.write([{ kind: "trade", data: persisted }]);
    const second = await writer.write([{ kind: "trade", data: persisted }]);

    expect(first).toEqual({ written: 1, skipped: 0, errors: [] });
    expect(second).toEqual({ written: 0, skipped: 1, errors: [] });
    expect(tx.indexedTrade.create).toHaveBeenCalledTimes(1);
  });

  it("collects per-record errors without aborting the transaction", async () => {
    const tx = createMockTx();
    tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
    tx.indexedTrade.create.mockRejectedValue(new Error("fk violation"));
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const writer = new PrismaBatchWriter();
    const result = await writer.write([
      { kind: "trade", data: withIdempotencyKey(TRADE) },
    ]);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("fk violation");
  });
});
