/**
 * Batch writer size / input DoS guard (#1152).
 *
 * Oversized or malformed batches are rejected with a typed error *before* any
 * database work happens, so a griefing producer cannot force an unbounded
 * transaction. The cap is configured via INDEXER_BATCH_MAX_RECORDS and a
 * malformed value falls back to the safe default — it never disables the guard.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PrismaBatchWriter,
  BatchWriteError,
  assertBatchWithinLimits,
  resolveMaxBatchRecords,
  DEFAULT_MAX_BATCH_RECORDS,
  MAX_BATCH_RECORDS_ENV_VAR,
} from "./batchWriter.js";
import { batchRejectedTotalCounter } from "./metrics.js";
import { withIdempotencyKey } from "./idempotency.js";
import type { NormalizedTrade } from "./types.js";

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

function trades(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    kind: "trade" as const,
    data: withIdempotencyKey({
      ...TRADE,
      eventId: `${String(i).padStart(10, "0")}-0000000001-0000000003`,
    }),
  }));
}

const mockPrisma = { $transaction: vi.fn() };

vi.mock("../../../src/services/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

describe("resolveMaxBatchRecords (#1152)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the safe cap when unset", () => {
    expect(resolveMaxBatchRecords({})).toBe(DEFAULT_MAX_BATCH_RECORDS);
  });

  it("honours a valid positive integer", () => {
    expect(resolveMaxBatchRecords({ [MAX_BATCH_RECORDS_ENV_VAR]: "25" })).toBe(
      25
    );
  });

  it("falls back to the default for malformed values (never fail-open)", () => {
    vi.stubEnv(MAX_BATCH_RECORDS_ENV_VAR, "not-a-number");
    expect(resolveMaxBatchRecords(process.env)).toBe(DEFAULT_MAX_BATCH_RECORDS);
    vi.unstubAllEnvs();

    vi.stubEnv(MAX_BATCH_RECORDS_ENV_VAR, "-5");
    expect(resolveMaxBatchRecords(process.env)).toBe(DEFAULT_MAX_BATCH_RECORDS);
    vi.unstubAllEnvs();

    vi.stubEnv(MAX_BATCH_RECORDS_ENV_VAR, "0");
    expect(resolveMaxBatchRecords(process.env)).toBe(DEFAULT_MAX_BATCH_RECORDS);
    vi.unstubAllEnvs();

    vi.stubEnv(MAX_BATCH_RECORDS_ENV_VAR, "   ");
    expect(resolveMaxBatchRecords(process.env)).toBe(DEFAULT_MAX_BATCH_RECORDS);
  });
});

describe("assertBatchWithinLimits (#1152)", () => {
  async function counterValue(reason: string): Promise<number> {
    const metric = (await batchRejectedTotalCounter.get()) as {
      values: Array<{ value: number; labels?: Record<string, string> }>;
    };
    const entry = metric.values.find(
      (value) => value.labels?.reason === reason
    );
    return entry ? entry.value : 0;
  }

  it("accepts a batch at the limit", () => {
    expect(() =>
      assertBatchWithinLimits(trades(3), { maxRecords: 3 })
    ).not.toThrow();
  });

  it("rejects a batch above the limit with a typed error", () => {
    let error: BatchWriteError | null = null;
    try {
      assertBatchWithinLimits(trades(4), { maxRecords: 3 });
    } catch (err) {
      error = err as BatchWriteError;
    }

    expect(error).toBeInstanceOf(BatchWriteError);
    expect(error!.code).toBe("BATCH_WRITE_TOO_LARGE");
    expect(error!.correlationId).toBeTruthy();
    expect(error!.message).toContain("4 records");
  });

  it("rejects a non-array payload with a typed error", () => {
    expect(() =>
      assertBatchWithinLimits("not-an-array" as any, { maxRecords: 10 })
    ).toThrow(expect.objectContaining({ code: "BATCH_WRITE_INVALID_INPUT" }));
    expect(() =>
      assertBatchWithinLimits(undefined as any, { maxRecords: 10 })
    ).toThrow(expect.objectContaining({ code: "BATCH_WRITE_INVALID_INPUT" }));
  });

  it("increments the batch-rejected metric for each denial", async () => {
    const tooLargeBefore = await counterValue("too_large");
    const invalidBefore = await counterValue("invalid_input");

    expect(() =>
      assertBatchWithinLimits(trades(5), { maxRecords: 1 })
    ).toThrow();
    expect(() =>
      assertBatchWithinLimits({} as any, { maxRecords: 1 })
    ).toThrow();

    expect(await counterValue("too_large")).toBe(tooLargeBefore + 1);
    expect(await counterValue("invalid_input")).toBe(invalidBefore + 1);
  });
});

describe("PrismaBatchWriter size guard (#1152)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMockTx() {
    return {
      indexerProcessedEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      indexedTrade: { create: vi.fn().mockResolvedValue({}) },
      resolutionCandidate: { create: vi.fn().mockResolvedValue({}) },
      collateralDeposit: { create: vi.fn().mockResolvedValue({}) },
      market: { upsert: vi.fn().mockResolvedValue({}) },
      userPosition: { upsert: vi.fn().mockResolvedValue({}) },
      indexedPosition: { upsert: vi.fn().mockResolvedValue({}) },
    };
  }

  it("rejects an oversized batch before opening a transaction", async () => {
    const writer = new PrismaBatchWriter(undefined, { maxRecords: 2 });

    await expect(writer.write(trades(3))).rejects.toMatchObject({
      code: "BATCH_WRITE_TOO_LARGE",
      name: "BatchWriteError",
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("still writes a batch that is within the limit", async () => {
    const tx = createMockTx();
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(tx));

    const writer = new PrismaBatchWriter(undefined, { maxRecords: 10 });
    const result = await writer.write(trades(2));

    expect(result.written).toBe(2);
    expect(tx.indexedTrade.create).toHaveBeenCalledTimes(2);
  });

  it("keeps the empty-batch fast path", async () => {
    const writer = new PrismaBatchWriter(undefined, { maxRecords: 1 });
    await expect(writer.write([])).resolves.toEqual({
      written: 0,
      skipped: 0,
      errors: [],
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid maxRecords configuration at construction", () => {
    expect(() => new PrismaBatchWriter(undefined, { maxRecords: 0 })).toThrow(
      BatchWriteError
    );
    expect(() => new PrismaBatchWriter(undefined, { maxRecords: 1.5 })).toThrow(
      expect.objectContaining({ code: "BATCH_WRITE_INVALID_INPUT" })
    );
  });

  it("applies the default cap when no override is configured", () => {
    expect(() =>
      assertBatchWithinLimits(trades(DEFAULT_MAX_BATCH_RECORDS + 1), {})
    ).toThrow(expect.objectContaining({ code: "BATCH_WRITE_TOO_LARGE" }));
    expect(() =>
      assertBatchWithinLimits(trades(DEFAULT_MAX_BATCH_RECORDS), {})
    ).not.toThrow();
  });
});
