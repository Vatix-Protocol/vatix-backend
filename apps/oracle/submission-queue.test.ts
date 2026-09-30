/**
 * Tests for submission queue types and validation.
 */

import { describe, it, expect, vi } from "vitest";
import type {
  SubmissionQueueItem,
  SubmissionQueueSnapshot,
  SubmissionStatus,
  OracleLockRedisClient,
} from "./submission-queue.js";
import type { ILogger } from "../../packages/shared/src/logger.js";
import {
  validateSubmissionQueueItem,
  SubmissionQueueValidationError,
  OracleSubmissionLock,
} from "./submission-queue.js";

function makeItem(
  overrides: Partial<SubmissionQueueItem> = {}
): SubmissionQueueItem {
  return {
    id: "item-1",
    request: {
      marketId: "market-001",
      oracleAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    },
    result: {
      outcome: true,
      confidence: 0.95,
      confidenceMetadata: { score: 0.95, method: "primary-provider" },
      source: "primary",
      sourceMetadata: { provider: "primary" },
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    status: "pending",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    attempts: 0,
    ...overrides,
  };
}

describe("SubmissionQueueItem", () => {
  it("accepts a valid pending item", () => {
    const item = makeItem();
    expect(item.status).toBe("pending");
    expect(item.attempts).toBe(0);
    expect(item.lastAttemptAt).toBeUndefined();
    expect(item.lastError).toBeUndefined();
  });

  it("accepts a submitted item with attempt metadata", () => {
    const item = makeItem({
      status: "submitted",
      attempts: 1,
      lastAttemptAt: "2026-01-01T00:01:00.000Z",
    });
    expect(item.status).toBe("submitted");
    expect(item.attempts).toBe(1);
    expect(item.lastAttemptAt).toBeDefined();
  });

  it("accepts a failed item with error message", () => {
    const item = makeItem({
      status: "failed",
      attempts: 3,
      lastAttemptAt: "2026-01-01T00:03:00.000Z",
      lastError: "Transaction rejected",
    });
    expect(item.status).toBe("failed");
    expect(item.lastError).toBe("Transaction rejected");
  });
});

describe("SubmissionStatus", () => {
  it("covers all valid status values", () => {
    const statuses: SubmissionStatus[] = ["pending", "submitted", "failed"];
    expect(statuses).toHaveLength(3);
  });
});

describe("SubmissionQueueSnapshot", () => {
  it("reflects counts and items correctly", () => {
    const snapshot: SubmissionQueueSnapshot = {
      pending: 2,
      submitted: 1,
      failed: 0,
      items: [makeItem(), makeItem({ id: "item-2" })],
    };
    expect(snapshot.pending).toBe(2);
    expect(snapshot.items).toHaveLength(2);
  });
});

// ─── validateSubmissionQueueItem ───────────────────────────────────────────────

describe("validateSubmissionQueueItem", () => {
  it("returns the item when valid", () => {
    const item = makeItem();
    expect(validateSubmissionQueueItem(item)).toEqual(item);
  });

  it("throws SubmissionQueueValidationError (statusCode 400) for null input", () => {
    expect(() => validateSubmissionQueueItem(null)).toThrow(
      SubmissionQueueValidationError
    );
    expect(() => validateSubmissionQueueItem(null)).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it("throws for missing id", () => {
    expect(() =>
      validateSubmissionQueueItem({ ...makeItem(), id: "" })
    ).toThrow(SubmissionQueueValidationError);
  });

  it("throws for missing request.marketId", () => {
    expect(() =>
      validateSubmissionQueueItem({
        ...makeItem(),
        request: { ...makeItem().request, marketId: "" },
      })
    ).toThrow(SubmissionQueueValidationError);
  });

  it("throws for missing request.oracleAddress", () => {
    expect(() =>
      validateSubmissionQueueItem({
        ...makeItem(),
        request: { ...makeItem().request, oracleAddress: "" },
      })
    ).toThrow(SubmissionQueueValidationError);
  });

  it("throws for invalid status", () => {
    expect(() =>
      validateSubmissionQueueItem({ ...makeItem(), status: "unknown" })
    ).toThrow(SubmissionQueueValidationError);
  });

  it("throws for negative attempts", () => {
    expect(() =>
      validateSubmissionQueueItem({ ...makeItem(), attempts: -1 })
    ).toThrow(SubmissionQueueValidationError);
  });

  it("throws for missing enqueuedAt", () => {
    expect(() =>
      validateSubmissionQueueItem({ ...makeItem(), enqueuedAt: "" })
    ).toThrow(SubmissionQueueValidationError);
  });
});

// ─── SubmissionQueue ─────────────────────────────────────────────────────────

import { SubmissionQueue } from "./submission-queue.js";

describe("SubmissionQueue", () => {
  it("enqueues a valid item and logs it", () => {
    const logs: Array<{
      level: string;
      msg: string;
      meta?: Record<string, unknown>;
    }> = [];
    const mockLogger: ILogger = {
      debug: () => {},
      info: (msg: string, meta?: Record<string, unknown>) =>
        logs.push({ level: "info", msg, meta }),
      warn: (msg: string, meta?: Record<string, unknown>) =>
        logs.push({ level: "warn", msg, meta }),
      error: (msg: string, meta?: Record<string, unknown>) =>
        logs.push({ level: "error", msg, meta }),
      child: () => mockLogger,
    };

    const queue = new SubmissionQueue(mockLogger);
    const item = makeItem();

    queue.enqueue(item);

    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe("info");
    expect(logs[0].msg).toBe("Oracle submission queued");
    expect(logs[0].meta).toMatchObject({
      id: item.id,
      marketId: item.request.marketId,
      oracleAddress: item.request.oracleAddress,
      status: item.status,
      enqueuedAt: item.enqueuedAt,
    });
  });

  it("throws when enqueueing an invalid item", () => {
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => mockLogger,
    };

    const queue = new SubmissionQueue(mockLogger);

    expect(() => queue.enqueue(null as any)).toThrow(
      SubmissionQueueValidationError
    );
  });
});

describe("OracleSubmissionLock (#1168)", () => {
  const createMockRedis = (): OracleLockRedisClient => ({
    set: vi.fn(),
    eval: vi.fn(),
  });

  it("constructs correct lock key with default prefix", () => {
    const mockRedis = createMockRedis();
    const lock = new OracleSubmissionLock({
      redisClient: mockRedis,
      keyPrefix: "vatix:",
    });

    expect(lock.getLockKey("market-123")).toBe(
      "vatix:oracle:submission-lock:market-123"
    );
  });

  it("constructs correct lock key with custom keyPrefix", () => {
    const mockRedis = createMockRedis();
    const lock = new OracleSubmissionLock({
      redisClient: mockRedis,
      keyPrefix: "staging:env:",
    });

    expect(lock.getLockKey("market-abc")).toBe(
      "staging:env:oracle:submission-lock:market-abc"
    );
  });

  it("acquires lock via atomic SET NX PX when free", async () => {
    const mockRedis = createMockRedis();
    (mockRedis.set as any).mockResolvedValueOnce("OK");

    const lock = new OracleSubmissionLock({
      redisClient: mockRedis,
      ttlMs: 45_000,
      keyPrefix: "test:",
    });

    const token = await lock.acquireLock("mkt-1", "token-uuid-1");

    expect(token).toBe("token-uuid-1");
    expect(mockRedis.set).toHaveBeenCalledWith(
      "test:oracle:submission-lock:mkt-1",
      "token-uuid-1",
      "PX",
      45_000,
      "NX"
    );
  });

  it("returns null when lock is already held by another replica", async () => {
    const mockRedis = createMockRedis();
    (mockRedis.set as any).mockResolvedValueOnce(null);

    const lock = new OracleSubmissionLock({
      redisClient: mockRedis,
      keyPrefix: "test:",
    });

    const token = await lock.acquireLock("mkt-1", "token-uuid-2");

    expect(token).toBeNull();
  });

  it("fails closed (returns null) on Redis connection error", async () => {
    const mockRedis = createMockRedis();
    (mockRedis.set as any).mockRejectedValueOnce(new Error("Redis ECONNREFUSED"));

    const lock = new OracleSubmissionLock({
      redisClient: mockRedis,
    });

    const token = await lock.acquireLock("mkt-err");

    expect(token).toBeNull();
  });

  it("safely releases lock only when holder token matches", async () => {
    const mockRedis = createMockRedis();
    (mockRedis.eval as any).mockResolvedValueOnce(1); // 1 = released

    const lock = new OracleSubmissionLock({
      redisClient: mockRedis,
      keyPrefix: "test:",
    });

    const released = await lock.releaseLock("mkt-1", "token-1");

    expect(released).toBe(true);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("if redis.call('get', KEYS[1]) == ARGV[1] then"),
      1,
      "test:oracle:submission-lock:mkt-1",
      "token-1"
    );
  });

  it("refuses to release lock when holder token does not match (CAS safety)", async () => {
    const mockRedis = createMockRedis();
    (mockRedis.eval as any).mockResolvedValueOnce(0); // 0 = not holder

    const lock = new OracleSubmissionLock({
      redisClient: mockRedis,
      keyPrefix: "test:",
    });

    const released = await lock.releaseLock("mkt-1", "wrong-token");

    expect(released).toBe(false);
  });

  it("extends lock TTL via compare-and-pexpire", async () => {
    const mockRedis = createMockRedis();
    (mockRedis.eval as any).mockResolvedValueOnce(1);

    const lock = new OracleSubmissionLock({
      redisClient: mockRedis,
      keyPrefix: "test:",
    });

    const extended = await lock.extendLock("mkt-1", "token-1", 30_000);

    expect(extended).toBe(true);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.stringContaining("pexpire"),
      1,
      "test:oracle:submission-lock:mkt-1",
      "token-1",
      "30000"
    );
  });
});

