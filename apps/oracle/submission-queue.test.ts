/**
 * Tests for submission queue types.
 */

import { describe, it, expect } from "vitest";
import type {
  SubmissionQueueItem,
  SubmissionQueueSnapshot,
  SubmissionStatus,
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
