/**
 * Unit tests for the settlement outbox publisher (#1288).
 *
 * Pins the retry/backoff schedule, the quarantine transition once the retry
 * budget is exhausted, and the exactly-once PUBLISHED transition on success.
 * No live Postgres or Redis is required: Prisma and the settlement queue are
 * stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueMock = vi.fn();

vi.mock("./settlement-queue.js", () => ({
  settlementQueue: { enqueue: enqueueMock },
}));

vi.mock("./metrics.js", () => {
  const counter = { inc: vi.fn() };
  const gauge = { set: vi.fn() };
  return {
    settlementOutboxDepthGauge: gauge,
    settlementOutboxLagSecondsGauge: gauge,
    settlementOutboxPublishFailuresTotal: counter,
    settlementOutboxOrphanedTradesGauge: gauge,
    settlementOutboxQuarantinedEntriesGauge: gauge,
    settlementOutboxQuarantineTransitionsTotal: counter,
  };
});

import { backoffMs, publishOutboxRow } from "./outbox-publisher.js";
import type { SettlementJob } from "./settlement-queue.js";

const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const QUARANTINE_ATTEMPTS_THRESHOLD = 10;

const payload: SettlementJob = {
  tradeId: "trade-1",
  marketId: "market-1",
  outcome: "YES",
  buyOrderId: "buy-1",
  sellOrderId: "sell-1",
  buyerAddress: "0xbuyer",
  sellerAddress: "0xseller",
  price: 0.5,
  quantity: 10,
  timestamp: 1_700_000_000_000,
};

function makePrisma() {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  return {
    prisma: { outboxEvent: { updateMany } } as never,
    updateMany,
  };
}

describe("backoffMs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("produces the exact capped exponential delay sequence for consecutive failures", () => {
    // rng() === 0 pins the deterministic half of equal jitter: capped / 2.
    const delays = [0, 1, 2, 3].map((attempts) => backoffMs(attempts, () => 0));
    expect(delays).toEqual([
      BASE_BACKOFF_MS / 2,
      (BASE_BACKOFF_MS * 2) / 2,
      (BASE_BACKOFF_MS * 4) / 2,
      (BASE_BACKOFF_MS * 8) / 2,
    ]);
  });

  it("caps the delay at the maximum backoff", () => {
    expect(backoffMs(20, () => 0)).toBe(MAX_BACKOFF_MS / 2);
    expect(backoffMs(20, () => 1)).toBe(MAX_BACKOFF_MS);
  });

  it("keeps jittered delays within [capped/2, capped]", () => {
    for (const attempts of [0, 1, 2, 3]) {
      const capped = Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
      const delay = backoffMs(attempts, () => 0.5);
      expect(delay).toBeGreaterThanOrEqual(capped / 2);
      expect(delay).toBeLessThanOrEqual(capped);
    }
  });
});

describe("publishOutboxRow", () => {
  beforeEach(() => {
    enqueueMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks the row PUBLISHED exactly once on a successful publish", async () => {
    enqueueMock.mockResolvedValue(undefined);
    const { prisma, updateMany } = makePrisma();

    const outcome = await publishOutboxRow(prisma, {
      tradeId: "trade-1",
      payload,
      attempts: 0,
    });

    expect(outcome).toBe("published");
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { tradeId: "trade-1", status: { not: "PUBLISHED" } },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
  });

  it("schedules the next attempt using the backoff delay on failure", async () => {
    enqueueMock.mockRejectedValue(new Error("redis down"));
    const { prisma, updateMany } = makePrisma();

    const outcome = await publishOutboxRow(prisma, {
      tradeId: "trade-1",
      payload,
      attempts: 0,
    });

    expect(outcome).toBe("failed");
    expect(updateMany).toHaveBeenCalledTimes(1);
    const args = updateMany.mock.calls[0][0] as {
      data: { status: string; attempts: number; nextAttemptAt: Date };
    };
    expect(args.data.status).toBe("FAILED");
    expect(args.data.attempts).toBe(1);
    // nextAttemptAt must be in the future, within the capped backoff window.
    const delay = args.data.nextAttemptAt.getTime() - Date.now();
    expect(delay).toBeGreaterThanOrEqual(BASE_BACKOFF_MS / 2);
    expect(delay).toBeLessThanOrEqual(BASE_BACKOFF_MS);
  });

  it("quarantines a row that exhausts the retry budget instead of retrying forever", async () => {
    enqueueMock.mockRejectedValue(new Error("permanent failure"));
    const { prisma, updateMany } = makePrisma();

    const outcome = await publishOutboxRow(prisma, {
      tradeId: "trade-1",
      payload,
      attempts: QUARANTINE_ATTEMPTS_THRESHOLD - 1,
    });

    expect(outcome).toBe("quarantined");
    expect(updateMany).toHaveBeenCalledTimes(1);
    const args = updateMany.mock.calls[0][0] as {
      where: unknown;
      data: {
        status: string;
        attempts: number;
        lastError: string;
        quarantinedAt: Date;
        nextAttemptAt?: Date;
      };
    };
    expect(args.where).toEqual({
      tradeId: "trade-1",
      status: { not: "PUBLISHED" },
    });
    expect(args.data.status).toBe("QUARANTINED");
    expect(args.data.attempts).toBe(QUARANTINE_ATTEMPTS_THRESHOLD);
    expect(args.data.lastError).toBe("permanent failure");
    expect(args.data.quarantinedAt).toBeInstanceOf(Date);
    // A quarantined row must not be rescheduled for another attempt.
    expect(args.data.nextAttemptAt).toBeUndefined();
  });
});
