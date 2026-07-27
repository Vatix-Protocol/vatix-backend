import { describe, it, expect, vi } from "vitest";
import {
  parseEventId,
  generateIdempotencyKey,
  withIdempotencyKey,
  insertIfNew,
  insertAllIfNew,
} from "./idempotency.js";
import type {
  NormalizedTrade,
  NormalizedResolution,
  NormalizedMarketCreated,
} from "./types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CONTRACT = "CTEST123";

function makeEvent(id: string, contractId = CONTRACT) {
  return { id, contractId };
}

const TRADE: NormalizedTrade = {
  eventId: "0000000042-0000000001-0000000003",
  ledger: 42,
  ledgerClosedAt: "2024-06-01T00:00:00Z",
  contractId: CONTRACT,
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
  contractId: CONTRACT,
  marketId: "market-xyz",
  outcome: "NO",
  oracleAddress: "GORACLE",
};

const MARKET_CREATED: NormalizedMarketCreated = {
  eventId: "0000000010-0000000000-0000000001",
  ledger: 10,
  ledgerClosedAt: "2024-05-01T00:00:00Z",
  contractId: CONTRACT,
  marketId: "market-new",
  question: "Will it rain tomorrow?",
  endTime: "2024-12-31T00:00:00Z",
  oracleAddress: "GORACLE",
  status: "ACTIVE",
};

// ─── parseEventId ─────────────────────────────────────────────────────────────

describe("parseEventId", () => {
  it("extracts ledger, txIndex, eventIndex from a valid id", () => {
    const r = parseEventId("0000000042-0000000001-0000000003");
    expect(r).toEqual({ ledger: 42, txIndex: 1, eventIndex: 3 });
  });

  it("handles zero-padded values correctly", () => {
    const r = parseEventId("0000000001-0000000000-0000000000");
    expect(r).toEqual({ ledger: 1, txIndex: 0, eventIndex: 0 });
  });

  it("handles large ledger numbers", () => {
    const r = parseEventId("9999999999-0000000100-0000000050");
    expect(r.ledger).toBe(9_999_999_999);
    expect(r.txIndex).toBe(100);
    expect(r.eventIndex).toBe(50);
  });

  it("throws on wrong number of segments", () => {
    expect(() => parseEventId("42-1")).toThrow();
    expect(() => parseEventId("42-1-3-9")).toThrow();
  });

  it("throws on non-numeric segments", () => {
    expect(() => parseEventId("0000000042-0000000001-XXXXXXXXXX")).toThrow();
  });

  it("throws on empty string", () => {
    expect(() => parseEventId("")).toThrow();
  });
});

// ─── generateIdempotencyKey ───────────────────────────────────────────────────

describe("generateIdempotencyKey", () => {
  it("returns a 64-character hex SHA-256 digest", () => {
    const { key } = generateIdempotencyKey(
      makeEvent("0000000042-0000000001-0000000003")
    );
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same input always produces the same key", () => {
    const e = makeEvent("0000000042-0000000001-0000000003");
    expect(generateIdempotencyKey(e).key).toBe(generateIdempotencyKey(e).key);
  });

  it("produces different keys for different ledgers", () => {
    const k1 = generateIdempotencyKey(
      makeEvent("0000000042-0000000001-0000000003")
    ).key;
    const k2 = generateIdempotencyKey(
      makeEvent("0000000043-0000000001-0000000003")
    ).key;
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different txIndex", () => {
    const k1 = generateIdempotencyKey(
      makeEvent("0000000042-0000000001-0000000003")
    ).key;
    const k2 = generateIdempotencyKey(
      makeEvent("0000000042-0000000002-0000000003")
    ).key;
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different eventIndex", () => {
    const k1 = generateIdempotencyKey(
      makeEvent("0000000042-0000000001-0000000003")
    ).key;
    const k2 = generateIdempotencyKey(
      makeEvent("0000000042-0000000001-0000000004")
    ).key;
    expect(k1).not.toBe(k2);
  });

  it("produces different keys for different contractIds", () => {
    const k1 = generateIdempotencyKey(
      makeEvent("0000000042-0000000001-0000000003", "CONTRACT_A")
    ).key;
    const k2 = generateIdempotencyKey(
      makeEvent("0000000042-0000000001-0000000003", "CONTRACT_B")
    ).key;
    expect(k1).not.toBe(k2);
  });

  it("exposes the parsed components", () => {
    const { components } = generateIdempotencyKey(
      makeEvent("0000000042-0000000001-0000000003")
    );
    expect(components).toEqual({
      contractId: CONTRACT,
      ledger: 42,
      txIndex: 1,
      eventIndex: 3,
    });
  });

  it("throws on invalid event id", () => {
    expect(() => generateIdempotencyKey(makeEvent("bad-id"))).toThrow();
  });
});

// ─── withIdempotencyKey ───────────────────────────────────────────────────────

describe("withIdempotencyKey", () => {
  it("stamps a NormalizedTrade with an idempotencyKey", () => {
    const persisted = withIdempotencyKey(TRADE);
    expect(persisted.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted.marketId).toBe(TRADE.marketId);
    expect(persisted.priceRaw).toBe(TRADE.priceRaw);
  });

  it("stamps a NormalizedResolution with an idempotencyKey", () => {
    const persisted = withIdempotencyKey(RESOLUTION);
    expect(persisted.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted.outcome).toBe(RESOLUTION.outcome);
  });

  it("stamps a NormalizedMarketCreated with an idempotencyKey", () => {
    const persisted = withIdempotencyKey(MARKET_CREATED);
    expect(persisted.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted.marketId).toBe(MARKET_CREATED.marketId);
  });

  it("market-created key matches what generateIdempotencyKey produces independently", () => {
    const expected = generateIdempotencyKey({
      id: MARKET_CREATED.eventId,
      contractId: MARKET_CREATED.contractId,
    }).key;
    expect(withIdempotencyKey(MARKET_CREATED).idempotencyKey).toBe(expected);
  });

  it("produces distinct keys for two different market-created events", () => {
    const other: NormalizedMarketCreated = {
      ...MARKET_CREATED,
      eventId: "0000000011-0000000000-0000000001",
    };
    expect(withIdempotencyKey(MARKET_CREATED).idempotencyKey).not.toBe(
      withIdempotencyKey(other).idempotencyKey
    );
  });

  it("key matches what generateIdempotencyKey produces independently", () => {
    const expected = generateIdempotencyKey({
      id: TRADE.eventId,
      contractId: TRADE.contractId,
    }).key;
    expect(withIdempotencyKey(TRADE).idempotencyKey).toBe(expected);
  });

  it("does not mutate the original record", () => {
    const original = { ...TRADE };
    withIdempotencyKey(TRADE);
    expect(TRADE).toEqual(original);
  });
});

// ─── insertIfNew ──────────────────────────────────────────────────────────────

describe("insertIfNew", () => {
  const persisted = withIdempotencyKey(TRADE);

  it("returns inserted status when upsert returns the record", async () => {
    const upsert = vi.fn().mockResolvedValue(persisted);
    const result = await insertIfNew(persisted, upsert);
    expect(result.status).toBe("inserted");
    if (result.status === "inserted") expect(result.record).toBe(persisted);
  });

  it("returns duplicate status when upsert returns null", async () => {
    const upsert = vi.fn().mockResolvedValue(null);
    const result = await insertIfNew(persisted, upsert);
    expect(result.status).toBe("duplicate");
    if (result.status === "duplicate")
      expect(result.key).toBe(persisted.idempotencyKey);
  });

  it("returns duplicate status when upsert returns undefined", async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const result = await insertIfNew(persisted, upsert);
    expect(result.status).toBe("duplicate");
  });

  it("calls upsert exactly once", async () => {
    const upsert = vi.fn().mockResolvedValue(persisted);
    await insertIfNew(persisted, upsert);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(persisted);
  });

  it("propagates upsert errors without swallowing them", async () => {
    const upsert = vi.fn().mockRejectedValue(new Error("db connection lost"));
    await expect(insertIfNew(persisted, upsert)).rejects.toThrow(
      "db connection lost"
    );
  });

  it("logs duplicates as structured no-ops", async () => {
    const logger = { info: vi.fn() };
    const upsert = vi.fn().mockResolvedValue(null);

    await insertIfNew(persisted, upsert, { logger });

    expect(logger.info).toHaveBeenCalledWith(
      "Skipping duplicate indexer event",
      {
        idempotencyKey: persisted.idempotencyKey,
        duplicateCount: 1,
      }
    );
  });

  it("continues inserting later events after duplicate no-ops", async () => {
    const later = { ...persisted, idempotencyKey: "later-key" };
    const upsert = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(later);

    const result = await insertAllIfNew([persisted, later], upsert);

    expect(result).toEqual({ inserted: [later], duplicateCount: 1 });
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it("does not insert a second market on a retried/duplicate market-created delivery (Issue #755)", async () => {
    const persistedMarket = withIdempotencyKey(MARKET_CREATED);

    // First delivery inserts the market; a retry (or duplicate RPC replay)
    // of the same ledger/tx/event position must be a no-op, not a second
    // market row.
    const upsert = vi
      .fn()
      .mockResolvedValueOnce(persistedMarket)
      .mockResolvedValueOnce(null);

    const first = await insertIfNew(persistedMarket, upsert);
    const second = await insertIfNew(persistedMarket, upsert);

    expect(first.status).toBe("inserted");
    expect(second.status).toBe("duplicate");
    if (second.status === "duplicate") {
      expect(second.key).toBe(persistedMarket.idempotencyKey);
    }
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(1, persistedMarket);
    expect(upsert).toHaveBeenNthCalledWith(2, persistedMarket);
  });
});
