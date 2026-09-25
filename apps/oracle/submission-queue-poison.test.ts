/**
 * Submission queue poison handling (#1150).
 *
 * A submission that keeps failing is quarantined after a bounded number of
 * attempts instead of being retried forever; quarantined items are terminal
 * and can never be replayed back into the loop. The queue also deduplicates
 * replayed enqueues (idempotency) and fails closed when it is at capacity.
 */

import { describe, it, expect, vi } from "vitest";
import type { ILogger } from "../../packages/shared/src/logger.js";
import {
  SubmissionQueue,
  SubmissionQueueError,
  SubmissionQueueValidationError,
  SUBMISSION_QUEUE_ERROR_CODES,
  type SubmissionQueueItem,
} from "./submission-queue.js";

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

describe("SubmissionQueue poison handling (#1150)", () => {
  it("deduplicates a replayed enqueue of a live item (idempotency)", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger);

    const first = queue.enqueue(makeItem());
    const second = queue.enqueue(makeItem());

    expect(second).toBe(first);
    expect(queue.getSnapshot().pending).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      "Oracle submission deduplicated",
      expect.objectContaining({ id: "item-1" })
    );
  });

  it("quarantines an item once the attempt threshold is reached", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger, {
      maxAttemptsBeforeQuarantine: 3,
    });
    queue.enqueue(makeItem());

    queue.recordFailure("item-1", "boom 1");
    expect(queue.require("item-1").status).toBe("failed");

    queue.recordFailure("item-1", "boom 2");
    expect(queue.require("item-1").status).toBe("failed");

    const result = queue.recordFailure("item-1", "boom 3");
    expect(result.status).toBe("quarantined");
    expect(result.attempts).toBe(3);
    expect(result.quarantinedAt).toBeDefined();
    expect(logger.error).toHaveBeenCalledWith(
      "Oracle submission quarantined as poison message",
      expect.objectContaining({ id: "item-1", attempts: 3 })
    );
  });

  it("is idempotent once quarantined — attempts stop accumulating", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger, {
      maxAttemptsBeforeQuarantine: 2,
    });
    queue.enqueue(makeItem());
    queue.recordFailure("item-1", "boom 1");
    queue.recordFailure("item-1", "boom 2");
    expect(queue.require("item-1").status).toBe("quarantined");

    const after = queue.recordFailure("item-1", "boom 3");
    expect(after.attempts).toBe(2);
    expect(after.status).toBe("quarantined");
  });

  it("refuses to re-enqueue a quarantined item (non-retryable poison error)", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger, {
      maxAttemptsBeforeQuarantine: 1,
    });
    queue.enqueue(makeItem());
    queue.recordFailure("item-1", "permanently rejected");

    let error: SubmissionQueueError | null = null;
    try {
      queue.enqueue(makeItem());
    } catch (err) {
      error = err as SubmissionQueueError;
    }

    expect(error).toBeInstanceOf(SubmissionQueueError);
    expect(error!.code).toBe(
      SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_POISON
    );
    expect(error!.retryable).toBe(false);
    expect(error!.statusCode).toBe(422);
    expect(error!.correlationId).toBeTruthy();
    expect(queue.getSnapshot().pending).toBe(0);
  });

  it("rejects a fresh enqueue whose attempt count already exceeds the threshold", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger, {
      maxAttemptsBeforeQuarantine: 3,
    });

    expect(() =>
      queue.enqueue(makeItem({ attempts: 5, status: "failed" }))
    ).toThrow(
      expect.objectContaining({
        code: SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_POISON,
      })
    );
    // Retained for forensics, but never eligible for processing.
    expect(queue.getSnapshot().quarantined).toBe(1);
  });

  it("never lets a success clear quarantine", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger, {
      maxAttemptsBeforeQuarantine: 1,
    });
    queue.enqueue(makeItem());
    queue.recordFailure("item-1", "boom");

    const after = queue.recordSuccess("item-1");
    expect(after.status).toBe("quarantined");
  });

  it("fails closed when the queue is at capacity (griefing guard)", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger, { maxQueueDepth: 2 });
    queue.enqueue(makeItem({ id: "a" }));
    queue.enqueue(makeItem({ id: "b" }));

    let error: SubmissionQueueError | null = null;
    try {
      queue.enqueue(makeItem({ id: "c" }));
    } catch (err) {
      error = err as SubmissionQueueError;
    }

    expect(error!.code).toBe(
      SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_FULL
    );
    expect(error!.retryable).toBe(true);
    expect(error!.statusCode).toBe(503);
    expect(queue.getSnapshot().pending).toBe(2);
  });

  it("reports a typed NOT_FOUND error for an unknown id", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger);

    expect(() => queue.require("nope")).toThrow(
      expect.objectContaining({
        code: SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_NOT_FOUND,
        statusCode: 404,
      })
    );
  });

  it("exposes quarantined items in the snapshot for operators", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger, {
      maxAttemptsBeforeQuarantine: 1,
    });
    queue.enqueue(makeItem({ id: "ok" }));
    queue.enqueue(makeItem({ id: "bad" }));
    queue.recordFailure("bad", "boom");

    const snapshot = queue.getSnapshot();
    expect(snapshot).toMatchObject({
      pending: 1,
      submitted: 0,
      failed: 0,
      quarantined: 1,
    });
    expect(snapshot.items).toHaveLength(2);
  });

  it("caps the stored error message (hostile-producer bloat guard)", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger, {
      maxAttemptsBeforeQuarantine: 100,
    });
    queue.enqueue(makeItem());

    const item = queue.recordFailure("item-1", "x".repeat(5_000));
    expect(item.lastError!.length).toBeLessThanOrEqual(513);
  });

  it("keeps a stable validation error code for malformed items", () => {
    const logger = makeLogger();
    const queue = new SubmissionQueue(logger);

    let error: SubmissionQueueValidationError | null = null;
    try {
      queue.enqueue(null as any);
    } catch (err) {
      error = err as SubmissionQueueValidationError;
    }

    expect(error).toBeInstanceOf(SubmissionQueueValidationError);
    expect(error!.statusCode).toBe(400);
    expect(error!.code).toBe(
      SUBMISSION_QUEUE_ERROR_CODES.SUBMISSION_QUEUE_INVALID_ITEM
    );
  });
});
