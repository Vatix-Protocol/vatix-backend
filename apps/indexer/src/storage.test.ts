import { describe, it, expect, vi } from "vitest";
import {
  generateIdempotencyKey,
  parseEventId,
  withIdempotencyKey,
  insertIfNew,
  IdempotencyError,
  IdempotencyErrorCode,
  type PersistedTrade,
} from "./idempotency.js";
import type { NormalizedTrade } from "./types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const EVENT_ID = "0000000042-0000000001-0000000003";

function makeTrade(overrides: Partial<NormalizedTrade> = {}): NormalizedTrade {
  return {
    eventId: EVENT_ID,
    contractId: CONTRACT_ID,
    ledger: 42,
    txIndex: 1,
    eventIndex: 3,
    ...overrides,
  } as NormalizedTrade;
}

// ─── Idempotency key derivation ──────────────────────────────────────────────

describe("storage: idempotency key derivation", () => {
  it("parses a well-formed Stellar event id into numeric components", () => {
    expect(parseEventId(EVENT_ID)).toEqual({
      ledger: 42,
      txIndex: 1,
      eventIndex: 3,
    });
  });

  it("is deterministic across replays of the same event", () => {
    const a = generateIdempotencyKey({ id: EVENT_ID, contractId: CONTRACT_ID });
    const b = generateIdempotencyKey({ id: EVENT_ID, contractId: CONTRACT_ID });
    expect(a.key).toBe(b.key);
    expect(a.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("scopes keys to contractId so identical event ids do not collide", () => {
    const a = generateIdempotencyKey({ id: EVENT_ID, contractId: CONTRACT_ID });
    const b = generateIdempotencyKey({
      id: EVENT_ID,
      contractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    });
    expect(a.key).not.toBe(b.key);
  });

  it("rejects malformed event ids with a stable error code", () => {
    for (const bad of ["", "42-1", "42-1-3-9", "42-x-3", "not-an-id"]) {
      try {
        parseEventId(bad);
        throw new Error(`expected parseEventId(${JSON.stringify(bad)}) to throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(IdempotencyError);
        expect((err as IdempotencyError).code).toBe(
          IdempotencyErrorCode.INVALID_EVENT_ID
        );
      }
    }
  });

  it("stamps a persisted record with its idempotency key", () => {
    const persisted = withIdempotencyKey(makeTrade());
    expect(persisted.idempotencyKey).toBe(
      generateIdempotencyKey({ id: EVENT_ID, contractId: CONTRACT_ID }).key
    );
  });
});

// ─── Persistence semantics ───────────────────────────────────────────────────

describe("storage: insertIfNew persistence semantics", () => {
  const record: PersistedTrade = withIdempotencyKey(makeTrade());

  it("reports inserted when the upsert returns the record", async () => {
    const upsert = vi.fn(async (r: PersistedTrade) => r);
    const result = await insertIfNew(record, upsert);
    expect(result).toEqual({ status: "inserted", record });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("reports duplicate when the upsert is a no-op on conflict", async () => {
    const result = await insertIfNew(record, async () => null);
    expect(result).toEqual({ status: "duplicate", key: record.idempotencyKey });
  });

  it("treats undefined as a duplicate no-op", async () => {
    const result = await insertIfNew(record, async () => undefined);
    expect(result.status).toBe("duplicate");
  });

  it("is idempotent under concurrent replay of the same event", async () => {
    const seen = new Set<string>();
    const upsert = async (r: PersistedTrade) => {
      if (seen.has(r.idempotencyKey)) return null;
      seen.add(r.idempotencyKey);
      return r;
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => insertIfNew(record, upsert))
    );
    const inserted = results.filter((r) => r.status === "inserted");
    const duplicates = results.filter((r) => r.status === "duplicate");
    expect(inserted).toHaveLength(1);
    expect(duplicates).toHaveLength(4);
  });
});

// ─── Fail-closed on dependency outage ────────────────────────────────────────

describe("storage: fail-closed on dependency outage", () => {
  const record: PersistedTrade = withIdempotencyKey(makeTrade());

  it("re-throws a typed STORE_UNAVAILABLE error when the store throws", async () => {
    const cause = new Error("ECONNREFUSED redis://cache:6379");
    await expect(
      insertIfNew(record, async () => {
        throw cause;
      })
    ).rejects.toMatchObject({
      name: "IdempotencyError",
      code: IdempotencyErrorCode.STORE_UNAVAILABLE,
    });
  });

  it("never reports a failed write as inserted", async () => {
    let result: unknown;
    try {
      result = await insertIfNew(record, async () => {
        throw new Error("db down");
      });
    } catch (err) {
      expect(err).toBeInstanceOf(IdempotencyError);
    }
    expect(result).toBeUndefined();
  });

  it("propagates the correlation id into the failure for tracing", async () => {
    const correlationId = "corr-1202";
    await expect(
      insertIfNew(
        record,
        async () => {
          throw new Error("rpc timeout");
        },
        { correlationId }
      )
    ).rejects.toMatchObject({ correlationId });
  });

  it("logs a warning without leaking secrets on outage", async () => {
    const warn = vi.fn();
    const info = vi.fn();
    await expect(
      insertIfNew(
        record,
        async () => {
          throw new Error("db down");
        },
        { logger: { info, warn }, correlationId: "corr-1202" }
      )
    ).rejects.toBeInstanceOf(IdempotencyError);
    expect(warn).toHaveBeenCalledTimes(1);
    const meta = warn.mock.calls[0][1] as Record<string, unknown>;
    expect(meta.code).toBe(IdempotencyErrorCode.STORE_UNAVAILABLE);
    expect(JSON.stringify(meta)).not.toMatch(/password|secret|token/i);
  });
});

// ─── Adversarial / griefing input ────────────────────────────────────────────

describe("storage: adversarial input handling", () => {
  it("rejects oversized / non-numeric event ids without throwing raw errors", () => {
    const adversarial = [
      "9".repeat(10_000) + "-1-1",
      "1-1-1\n",
      "1-1-1; DROP TABLE trades;--",
      "-1-1-1",
      "1--1-1",
    ];
    for (const bad of adversarial) {
      expect(() => parseEventId(bad)).toThrow(IdempotencyError);
    }
  });

  it("does not mutate the input record when stamping a key", () => {
    const trade = makeTrade();
    const snapshot = JSON.stringify(trade);
    withIdempotencyKey(trade);
    expect(JSON.stringify(trade)).toBe(snapshot);
  });
});

// ─── Testnet vs mainnet address drift ────────────────────────────────────────

describe("storage: testnet vs mainnet address drift", () => {
  it("produces distinct keys for the same event id on different networks", () => {
    const testnet = generateIdempotencyKey({
      id: EVENT_ID,
      contractId: "CTESTNETCONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const mainnet = generateIdempotencyKey({
      id: EVENT_ID,
      contractId: "CMAINNETCONTRACTAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(testnet.key).not.toBe(mainnet.key);
  });

  it("keeps keys stable when only the network contract id changes", () => {
    const a = generateIdempotencyKey({ id: EVENT_ID, contractId: CONTRACT_ID });
    const b = generateIdempotencyKey({ id: EVENT_ID, contractId: CONTRACT_ID });
    expect(a.components).toEqual(b.components);
    expect(a.key).toBe(b.key);
  });
});
