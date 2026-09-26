/**
 * Oracle submission queue — deterministic idempotency keys and conflict
 * detection (#1114).
 *
 * The enqueue `id` is the queue's deduplication key. These tests cover:
 *   - the key is a pure function of the resolution (no clock, no randomness),
 *   - a replay of the same work is a no-op (no double submission),
 *   - the same id with a *different* resolution is a conflict, not a replay,
 *     and is surfaced with a stable, non-retryable error code.
 */

import { describe, it, expect, vi } from "vitest";
import type { ILogger } from "../../packages/shared/src/logger.js";
import {
  SubmissionQueue,
  SubmissionQueueError,
  SubmissionQueueValidationError,
  SUBMISSION_QUEUE_ERROR_CODES,
  buildSubmissionIdempotencyKey,
  isSameSubmissionPayload,
  type SubmissionQueueItem,
} from "./submission-queue.js";

const ORACLE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_ORACLE = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ILogger;
}

function makeItem(
  overrides: Partial<SubmissionQueueItem> = {}
): SubmissionQueueItem {
  return {
    id: buildSubmissionIdempotencyKey({
      marketId: "market-001",
      oracleAddress: ORACLE,
      resolvedAt: "2026-01-01T00:00:00.000Z",
    }),
    request: { marketId: "market-001", oracleAddress: ORACLE },
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

describe("buildSubmissionIdempotencyKey (#1114)", () => {
  it("is a pure function of the resolution", () => {
    const a = buildSubmissionIdempotencyKey({
      marketId: "market-001",
      oracleAddress: ORACLE,
      resolvedAt: "2026-01-01T00:00:00.000Z",
    });
    const b = buildSubmissionIdempotencyKey({
      marketId: "market-001",
      oracleAddress: ORACLE,
      resolvedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(a).toBe(b);
    expect(a).toBe(`market-001:${ORACLE}:2026-01-01T00:00:00.000Z`);
  });

  it("normalises equivalent timestamp spellings to one key", () => {
    const utc = buildSubmissionIdempotencyKey({
      marketId: "market-001",
      oracleAddress: ORACLE,
      resolvedAt: "2026-01-01T00:00:00.000Z",
    });
    const offset = buildSubmissionIdempotencyKey({
      marketId: "market-001",
      oracleAddress: ORACLE,
      resolvedAt: "2026-01-01T01:00:00.000+01:00",
    });

    expect(utc).toBe(offset);
  });

  it("separates different markets, oracles and resolution times", () => {
    const base = {
      marketId: "market-001",
      oracleAddress: ORACLE,
      resolvedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(
      buildSubmissionIdempotencyKey({ ...base, marketId: "market-002" })
    ).not.toBe(buildSubmissionIdempotencyKey(base));
    expect(
      buildSubmissionIdempotencyKey({ ...base, oracleAddress: OTHER_ORACLE })
    ).not.toBe(buildSubmissionIdempotencyKey(base));
    expect(
      buildSubmissionIdempotencyKey({
        ...base,
        resolvedAt: "2026-01-01T00:00:01.000Z",
      })
    ).not.toBe(buildSubmissionIdempotencyKey(base));
  });

  it("rejects missing components and unparseable timestamps", () => {
    expect(() =>
      buildSubmissionIdempotencyKey({
        marketId: "",
        oracleAddress: ORACLE,
        resolvedAt: "2026-01-01T00:00:00.000Z",
      })
    ).toThrow(SubmissionQueueValidationError);

    expect(() =>
      buildSubmissionIdempotencyKey({
        marketId: "market-001",
        oracleAddress: ORACLE,
        resolvedAt: "not-a-date",
      })
    ).toThrow(SubmissionQueueValidationError);
  });
});

describe("isSameSubmissionPayload (#1114)", () => {
  it("ignores mutable bookkeeping", () => {
    const a = makeItem();
    const b = makeItem({
      status: "failed",
      attempts: 3,
      enqueuedAt: "2026-02-02T00:00:00.000Z",
    });

    expect(isSameSubmissionPayload(a, b)).toBe(true);
  });

  it("detects a different outcome, source or timestamp", () => {
    const base = makeItem();

    expect(
      isSameSubmissionPayload(base, {
        ...makeItem(),
        result: { ...base.result, outcome: false },
      })
    ).toBe(false);
    expect(
      isSameSubmissionPayload(base, {
        ...makeItem(),
        result: { ...base.result, timestamp: "2026-01-02T00:00:00.000Z" },
      })
    ).toBe(false);
    expect(
      isSameSubmissionPayload(base, {
        ...makeItem(),
        result: { ...base.result, source: "fallback-1" },
      })
    ).toBe(false);
  });
});

describe("SubmissionQueue idempotency (#1114)", () => {
  it("treats a replayed enqueue of the same work as a no-op", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger);

    const first = queue.enqueue(makeItem());
    const replay = queue.enqueue(makeItem());

    expect(replay).toBe(first);
    expect(queue.getSnapshot().pending).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      "Oracle submission deduplicated",
      expect.objectContaining({ marketId: "market-001" })
    );
  });

  it("survives many replays without growing the queue", () => {
    const queue = new SubmissionQueue(makeLogger());

    for (let i = 0; i < 25; i += 1) {
      queue.enqueue(
        makeItem({ enqueuedAt: `2026-01-01T00:00:0${i % 10}.000Z` })
      );
    }

    expect(queue.getSnapshot().pending).toBe(1);
  });

  it("fails closed with a stable code when the same id carries a different resolution", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger);
    const first = queue.enqueue(makeItem());

    let error: SubmissionQueueError | null = null;
    try {
      queue.enqueue(makeItem({ result: { ...first.result, outcome: false } }));
    } catch (err) {
      error = err as SubmissionQueueError;
    }

    expect(error).toBeInstanceOf(SubmissionQueueError);
    expect(error?.code).toBe(
      SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_IDEMPOTENCY_CONFLICT
    );
    expect(error?.retryable).toBe(false);
    expect(error?.statusCode).toBe(409);
    expect(error?.correlationId).toMatch(/^sq_/);
    // The live entry is untouched — a conflicting write never overwrites it.
    expect(queue.require(first.id).result.outcome).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "Oracle submission idempotency conflict",
      expect.objectContaining({
        marketId: "market-001",
        code: SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_IDEMPOTENCY_CONFLICT,
      })
    );
  });

  it("can be configured to keep the previous return-existing behaviour", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger, {
      idempotencyConflict: "return-existing",
    });
    const first = queue.enqueue(makeItem());

    const replay = queue.enqueue(
      makeItem({ result: { ...first.result, outcome: false } })
    );

    expect(replay).toBe(first);
    expect(queue.getSnapshot().pending).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Oracle submission idempotency conflict",
      expect.objectContaining({ marketId: "market-001" })
    );
  });

  it("keeps a quarantined replay a poison error, not an idempotency conflict", () => {
    const queue = new SubmissionQueue(makeLogger(), {
      maxAttemptsBeforeQuarantine: 1,
    });
    queue.enqueue(makeItem());
    queue.recordFailure(makeItem().id, "permanently rejected");

    try {
      queue.enqueue(makeItem());
      throw new Error("expected a poison error");
    } catch (error) {
      expect(error).toBeInstanceOf(SubmissionQueueError);
      expect((error as SubmissionQueueError).code).toBe(
        SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_POISON
      );
    }
  });
});
