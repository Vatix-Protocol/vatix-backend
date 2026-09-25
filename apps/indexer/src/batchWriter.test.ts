import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrismaBatchWriter } from "./batchWriter.js";
import { withIdempotencyKey } from "./idempotency.js";
import type {
  NormalizedTrade,
  NormalizedResolution,
  NormalizedCollateralDeposit,
  NormalizedMarketCreated,
} from "./types.js";

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
  confidenceScore: null,
};

const COLLATERAL_DEPOSIT: NormalizedCollateralDeposit = {
  eventId: "0000000050-0000000001-0000000002",
  ledger: 50,
  ledgerClosedAt: "2024-07-01T00:00:00Z",
  contractId: "CTEST",
  account: "GDEPOSITOR",
  marketId: "market-deposit",
  amountRaw: 250_000_000n,
};

const MARKET_CREATED: NormalizedMarketCreated = {
  eventId: "0000000010-0000000000-0000000001",
  ledger: 10,
  ledgerClosedAt: "2024-05-01T00:00:00Z",
  contractId: "CTEST",
  marketId: "market-new",
  question: "Will it rain tomorrow?",
  endTime: "2024-12-31T00:00:00Z",
  oracleAddress: "GORACLE",
  status: "ACTIVE",
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
    collateralDeposit: {
      create: vi.fn().mockResolvedValue({}),
    },
    market: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    userPosition: {
      upsert: vi.fn().mockResolvedValue({}),
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
          confidenceScore: null,
        }),
      })
    );
  });

  it("persists confidenceScore when present on resolution", async () => {
    const tx = createMockTx();
    tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const resolutionWithConfidence: NormalizedResolution = {
      ...RESOLUTION,
      eventId: "0000000099-0000000002-0000000001",
      confidenceScore: 0.95,
    };

    const writer = new PrismaBatchWriter();
    await writer.write([
      {
        kind: "resolution",
        data: withIdempotencyKey(resolutionWithConfidence),
      },
    ]);

    expect(tx.resolutionCandidate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ confidenceScore: 0.95 }),
      })
    );
  });

  it("writes a collateral_deposited record", async () => {
    const tx = createMockTx();
    tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const writer = new PrismaBatchWriter();
    const result = await writer.write([
      {
        kind: "collateral_deposited",
        data: withIdempotencyKey(COLLATERAL_DEPOSIT),
      },
    ]);

    expect(result).toEqual({ written: 1, skipped: 0, errors: [] });
    expect(tx.collateralDeposit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          account: "GDEPOSITOR",
          marketId: "market-deposit",
          amountRaw: "250000000",
        }),
      })
    );
  });

  it("writes a market_created record via upsert", async () => {
    const tx = createMockTx();
    tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const writer = new PrismaBatchWriter();
    const result = await writer.write([
      { kind: "market_created", data: withIdempotencyKey(MARKET_CREATED) },
    ]);

    expect(result).toEqual({ written: 1, skipped: 0, errors: [] });
    expect(tx.market.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "market-new" },
        create: expect.objectContaining({
          id: "market-new",
          question: "Will it rain tomorrow?",
          oracleAddress: "GORACLE",
          status: "ACTIVE",
        }),
        update: expect.objectContaining({
          question: "Will it rain tomorrow?",
        }),
      })
    );
  });

  it("writes all four event kinds in a single batch", async () => {
    const tx = createMockTx();
    tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const writer = new PrismaBatchWriter();
    const result = await writer.write([
      { kind: "trade", data: withIdempotencyKey(TRADE) },
      { kind: "resolution", data: withIdempotencyKey(RESOLUTION) },
      {
        kind: "collateral_deposited",
        data: withIdempotencyKey(COLLATERAL_DEPOSIT),
      },
      { kind: "market_created", data: withIdempotencyKey(MARKET_CREATED) },
    ]);

    expect(result).toEqual({ written: 4, skipped: 0, errors: [] });
    expect(tx.indexedTrade.create).toHaveBeenCalledTimes(1);
    expect(tx.resolutionCandidate.create).toHaveBeenCalledTimes(1);
    expect(tx.collateralDeposit.create).toHaveBeenCalledTimes(1);
    expect(tx.market.upsert).toHaveBeenCalledTimes(1);
  });

  it("skips duplicate replays", async () => {
    const tx = createMockTx();
    const persisted = withIdempotencyKey(TRADE);
    tx.indexerProcessedEvent.findUnique
      .mockResolvedValueOnce(null)
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

  it("skips duplicate collateral_deposited replays", async () => {
    const tx = createMockTx();
    const persisted = withIdempotencyKey(COLLATERAL_DEPOSIT);
    tx.indexerProcessedEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ idempotencyKey: persisted.idempotencyKey });
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const writer = new PrismaBatchWriter();
    const first = await writer.write([
      { kind: "collateral_deposited", data: persisted },
    ]);
    const second = await writer.write([
      { kind: "collateral_deposited", data: persisted },
    ]);

    expect(first).toEqual({ written: 1, skipped: 0, errors: [] });
    expect(second).toEqual({ written: 0, skipped: 1, errors: [] });
    expect(tx.collateralDeposit.create).toHaveBeenCalledTimes(1);
  });

  it("skips duplicate market_created replays", async () => {
    const tx = createMockTx();
    const persisted = withIdempotencyKey(MARKET_CREATED);
    tx.indexerProcessedEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ idempotencyKey: persisted.idempotencyKey });
    mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

    const writer = new PrismaBatchWriter();
    const first = await writer.write([
      { kind: "market_created", data: persisted },
    ]);
    const second = await writer.write([
      { kind: "market_created", data: persisted },
    ]);

    expect(first).toEqual({ written: 1, skipped: 0, errors: [] });
    expect(second).toEqual({ written: 0, skipped: 1, errors: [] });
    expect(tx.market.upsert).toHaveBeenCalledTimes(1);
  });

  describe("mid-batch failure rolls back the whole batch (Issue #756)", () => {
    it("rejects write() instead of returning a partial result when a record fails to persist", async () => {
      const tx = createMockTx();
      tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
      tx.indexedTrade.create.mockRejectedValue(new Error("fk violation"));
      mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

      const writer = new PrismaBatchWriter();
      await expect(
        writer.write([{ kind: "trade", data: withIdempotencyKey(TRADE) }])
      ).rejects.toThrow("fk violation");
    });

    it("stops processing subsequent records once one record fails (no partial commit)", async () => {
      const tx = createMockTx();
      tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
      tx.indexedTrade.create.mockRejectedValue(new Error("fk violation"));
      mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

      const writer = new PrismaBatchWriter();
      await expect(
        writer.write([
          { kind: "trade", data: withIdempotencyKey(TRADE) },
          { kind: "market_created", data: withIdempotencyKey(MARKET_CREATED) },
        ])
      ).rejects.toThrow("fk violation");

      // The trade record failed first — the market_created record after it
      // must never be attempted within the same (now-aborted) transaction.
      expect(tx.market.upsert).not.toHaveBeenCalled();
    });

    it("does not retry a non-retryable mid-batch persist failure", async () => {
      const tx = createMockTx();
      tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
      tx.market.upsert.mockRejectedValue(new Error("constraint violation"));
      mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

      const writer = new PrismaBatchWriter();
      await expect(
        writer.write([
          { kind: "market_created", data: withIdempotencyKey(MARKET_CREATED) },
        ])
      ).rejects.toThrow("constraint violation");

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  describe("transient DB error retry", () => {
    it("retries on a P1001 (cannot reach database) error and succeeds", async () => {
      const tx = createMockTx();
      tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);

      const transientErr = Object.assign(new Error("Cannot reach database"), {
        code: "P1001",
      });

      // First call throws, second succeeds
      mockPrisma.$transaction
        .mockRejectedValueOnce(transientErr)
        .mockImplementation(async (fn) => fn(tx));

      const writer = new PrismaBatchWriter();
      const result = await writer.write([
        { kind: "trade", data: withIdempotencyKey(TRADE) },
      ]);

      expect(result.written).toBe(1);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it("retries on a serialization failure (40001) and succeeds", async () => {
      const tx = createMockTx();
      tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);

      const serializationErr = Object.assign(
        new Error("could not serialize access"),
        { code: "40001" }
      );

      mockPrisma.$transaction
        .mockRejectedValueOnce(serializationErr)
        .mockImplementation(async (fn) => fn(tx));

      const writer = new PrismaBatchWriter();
      const result = await writer.write([
        { kind: "resolution", data: withIdempotencyKey(RESOLUTION) },
      ]);

      expect(result.written).toBe(1);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it("throws after exhausting retries on persistent transient error", async () => {
      const transientErr = Object.assign(new Error("timeout"), {
        code: "P1008",
      });
      mockPrisma.$transaction.mockRejectedValue(transientErr);

      const writer = new PrismaBatchWriter();
      await expect(
        writer.write([{ kind: "trade", data: withIdempotencyKey(TRADE) }])
      ).rejects.toThrow("timeout");

      // 1 initial + 3 retries = 4 total
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(4);
    });

    it("does not retry on a non-transient error", async () => {
      const nonTransientErr = new Error("syntax error in SQL");
      mockPrisma.$transaction.mockRejectedValue(nonTransientErr);

      const writer = new PrismaBatchWriter();
      await expect(
        writer.write([{ kind: "trade", data: withIdempotencyKey(TRADE) }])
      ).rejects.toThrow("syntax error");

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("logs a warning on each retry attempt", async () => {
      const warnSpy = vi.fn();
      const logger = {
        warn: warnSpy,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const tx = createMockTx();
      tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);

      const transientErr = Object.assign(new Error("deadlock"), {
        code: "40P01",
      });

      mockPrisma.$transaction
        .mockRejectedValueOnce(transientErr)
        .mockImplementation(async (fn) => fn(tx));

      const writer = new PrismaBatchWriter(logger as any);
      await writer.write([{ kind: "trade", data: withIdempotencyKey(TRADE) }]);

      expect(warnSpy).toHaveBeenCalledWith(
        "Transient DB error in batch write, retrying",
        expect.objectContaining({ attempt: 1 })
      );
    });
  });

  describe("trade quantity -> UserPosition share reconciliation (#948)", () => {
    it("credits/debits whole-share deltas for both sides of the trade", async () => {
      const tx = createMockTx();
      tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));

      const writer = new PrismaBatchWriter();
      const result = await writer.write([
        { kind: "trade", data: withIdempotencyKey(TRADE) },
      ]);

      expect(result.written).toBe(1);
      // TRADE: outcome YES, direction buy, quantityRaw 100n — trader gains
      // 100 whole YES shares, counterparty loses 100.
      expect(tx.userPosition.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            marketId_userAddress: {
              marketId: TRADE.marketId,
              userAddress: TRADE.traderAddress,
            },
          },
          create: expect.objectContaining({ yesShares: 100, noShares: 0 }),
          update: expect.objectContaining({
            yesShares: { increment: 100 },
          }),
        })
      );
      expect(tx.userPosition.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            marketId_userAddress: {
              marketId: TRADE.marketId,
              userAddress: TRADE.counterpartyAddress,
            },
          },
          update: expect.objectContaining({
            yesShares: { increment: -100 },
          }),
        })
      );
    });

    it("skips position reconciliation (without failing the batch) when quantityRaw exceeds safe-integer range", async () => {
      const tx = createMockTx();
      tx.indexerProcessedEvent.findUnique.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn) => fn(tx));
      const warnSpy = vi.fn();

      const corrupted = {
        ...TRADE,
        quantityRaw: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      };

      const writer = new PrismaBatchWriter({
        warn: warnSpy,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any);

      const result = await writer.write([
        { kind: "trade", data: withIdempotencyKey(corrupted) },
      ]);

      // The trade itself is still the source of truth and gets written —
      // only the best-effort position projection is skipped.
      expect(result.written).toBe(1);
      expect(tx.userPosition.upsert).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        "Skipping position reconciliation: invalid trade quantity",
        expect.objectContaining({
          error: expect.stringContaining("exceeds Number.MAX_SAFE_INTEGER"),
        })
      );
    });
  });

  describe("concurrent batch writers (#946)", () => {
    it("treats a concurrent unique-constraint conflict as a duplicate after retrying", async () => {
      // First attempt: another writer's transaction committed the same
      // idempotency-keyed row a moment earlier — our INSERT collides.
      const conflictErr = Object.assign(
        new Error(
          "Unique constraint failed on the fields: (`idempotency_key`)"
        ),
        { code: "P2002" }
      );

      // Second attempt: a fresh transaction now sees the row the other
      // writer committed, so the dedup check correctly classifies it as
      // a duplicate instead of racing the INSERT again.
      const retryTx = createMockTx();
      retryTx.indexerProcessedEvent.findUnique.mockResolvedValue({
        idempotencyKey: withIdempotencyKey(TRADE).idempotencyKey,
      });

      mockPrisma.$transaction
        .mockRejectedValueOnce(conflictErr)
        .mockImplementation(async (fn) => fn(retryTx));

      const writer = new PrismaBatchWriter();
      const result = await writer.write([
        { kind: "trade", data: withIdempotencyKey(TRADE) },
      ]);

      expect(result.written).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
      // The record must never be re-inserted once recognised as a duplicate.
      expect(retryTx.indexedTrade.create).not.toHaveBeenCalled();
    });

    it("still writes the other genuinely-new records in the batch after a concurrent conflict", async () => {
      const conflictErr = Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      });

      const tradeKey = withIdempotencyKey(TRADE).idempotencyKey;
      const retryTx = createMockTx();
      retryTx.indexerProcessedEvent.findUnique.mockImplementation(
        async ({ where }: { where: { idempotencyKey: string } }) =>
          where.idempotencyKey === tradeKey
            ? { idempotencyKey: tradeKey }
            : null
      );

      mockPrisma.$transaction
        .mockRejectedValueOnce(conflictErr)
        .mockImplementation(async (fn) => fn(retryTx));

      const writer = new PrismaBatchWriter();
      const result = await writer.write([
        { kind: "trade", data: withIdempotencyKey(TRADE) },
        { kind: "market_created", data: withIdempotencyKey(MARKET_CREATED) },
      ]);

      expect(result.written).toBe(1);
      expect(result.skipped).toBe(1);
      expect(retryTx.market.upsert).toHaveBeenCalled();
      expect(retryTx.indexedTrade.create).not.toHaveBeenCalled();
    });

    it("throws after exhausting retries when conflicts persist across every attempt", async () => {
      const conflictErr = Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      });
      mockPrisma.$transaction.mockRejectedValue(conflictErr);

      const writer = new PrismaBatchWriter();
      await expect(
        writer.write([{ kind: "trade", data: withIdempotencyKey(TRADE) }])
      ).rejects.toThrow("Unique constraint failed");

      // 1 initial + 3 retries = 4 total — never retries forever.
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(4);
    });
  });
});
