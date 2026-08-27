/**
 * Settlement Outbox Publisher Tests
 *
 * Verifies the transactional-outbox recovery path: a trade committed to
 * Postgres with an OutboxEvent row must reach the settlement queue at
 * least once, even if the enqueue call fails (simulated Redis outage /
 * process crash) on the first attempt. Also verifies idempotency: draining
 * the same row twice (two publisher instances racing, or a retry after a
 * crash mid-publish) never errors and always converges on PUBLISHED.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./settlement-queue.js", () => ({
  settlementQueue: {
    enqueue: vi.fn(),
  },
}));

vi.mock("./prisma.js", () => ({
  getPrismaClient: vi.fn(),
}));

vi.mock("./metrics.js", () => ({
  settlementOutboxDepthGauge: { set: vi.fn() },
  settlementOutboxLagSecondsGauge: { set: vi.fn() },
  settlementOutboxPublishFailuresTotal: { inc: vi.fn() },
  settlementOutboxOrphanedTradesGauge: { set: vi.fn() },
  settlementOutboxQuarantinedEntriesGauge: { set: vi.fn() },
  settlementOutboxQuarantineTransitionsTotal: { inc: vi.fn() },
}));

import { settlementQueue } from "./settlement-queue.js";
import {
  settlementOutboxDepthGauge,
  settlementOutboxLagSecondsGauge,
  settlementOutboxOrphanedTradesGauge,
  settlementOutboxQuarantinedEntriesGauge,
  settlementOutboxQuarantineTransitionsTotal,
} from "./metrics.js";
import {
  buildSettlementPayload,
  publishOutboxRow,
  drainOutboxOnce,
  refreshOutboxMetrics,
  type OutboxRow,
} from "./outbox-publisher.js";

function makeTrade(
  overrides?: Partial<Parameters<typeof buildSettlementPayload>[0]>
) {
  return {
    id: "trade-1",
    marketId: "market-1",
    outcome: "YES",
    buyOrderId: "buy-1",
    sellOrderId: "sell-1",
    buyerAddress: "GBUYER0000000000000000000000000000000000000000000000",
    sellerAddress: "GSELLER000000000000000000000000000000000000000000000",
    price: 0.5,
    quantity: 10,
    timestamp: 1700000000000,
    ...overrides,
  };
}

function makeMockPrisma() {
  return {
    outboxEvent: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  };
}

describe("buildSettlementPayload", () => {
  it("maps a Trade into the SettlementJob shape", () => {
    const trade = makeTrade();
    const payload = buildSettlementPayload(trade);

    expect(payload).toEqual({
      tradeId: "trade-1",
      marketId: "market-1",
      outcome: "YES",
      buyOrderId: "buy-1",
      sellOrderId: "sell-1",
      buyerAddress: trade.buyerAddress,
      sellerAddress: trade.sellerAddress,
      price: 0.5,
      quantity: 10,
      timestamp: 1700000000000,
    });
  });
});

describe("publishOutboxRow", () => {
  let mockPrisma: ReturnType<typeof makeMockPrisma>;
  let row: OutboxRow;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = makeMockPrisma();
    row = {
      tradeId: "trade-1",
      payload: buildSettlementPayload(makeTrade()),
      attempts: 0,
    };
  });

  it("marks the row PUBLISHED when enqueue succeeds", async () => {
    vi.mocked(settlementQueue.enqueue).mockResolvedValue(undefined);

    const outcome = await publishOutboxRow(mockPrisma as any, row);

    expect(outcome).toBe("published");
    expect(settlementQueue.enqueue).toHaveBeenCalledWith(row.payload);
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { tradeId: "trade-1", status: { not: "PUBLISHED" } },
      data: { status: "PUBLISHED", publishedAt: expect.any(Date) },
    });
  });

  it("marks the row FAILED with incremented attempts and backoff when Redis is down", async () => {
    vi.mocked(settlementQueue.enqueue).mockRejectedValue(
      new Error("ECONNREFUSED: redis down")
    );

    const outcome = await publishOutboxRow(mockPrisma as any, row);

    expect(outcome).toBe("failed");
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { tradeId: "trade-1", status: { not: "PUBLISHED" } },
      data: {
        status: "FAILED",
        attempts: 1,
        lastError: expect.stringContaining("redis down"),
        nextAttemptAt: expect.any(Date),
      },
    });
  });

  it("crash mid-publish: enqueue succeeds but the row was never re-read — a retry of the SAME row is idempotent", async () => {
    // Simulates: enqueue succeeded, then the process crashed before the
    // updateMany landed. On restart, the publisher drains the row again
    // (still PENDING/FAILED in the DB) and retries — this must not throw,
    // must not double-apply anything, and must still converge on PUBLISHED.
    vi.mocked(settlementQueue.enqueue).mockResolvedValue(undefined);

    const first = await publishOutboxRow(mockPrisma as any, row);
    const second = await publishOutboxRow(mockPrisma as any, row);

    expect(first).toBe("published");
    expect(second).toBe("published");
    expect(settlementQueue.enqueue).toHaveBeenCalledTimes(2);
    expect(settlementQueue.enqueue).toHaveBeenNthCalledWith(1, row.payload);
    expect(settlementQueue.enqueue).toHaveBeenNthCalledWith(2, row.payload);
  });

  it("recovers after a transient failure: FAILED row retried later succeeds", async () => {
    vi.mocked(settlementQueue.enqueue).mockRejectedValueOnce(
      new Error("redis down")
    );
    vi.mocked(settlementQueue.enqueue).mockResolvedValueOnce(undefined);

    const failedOutcome = await publishOutboxRow(mockPrisma as any, row);
    expect(failedOutcome).toBe("failed");

    const retryRow: OutboxRow = { ...row, attempts: 1 };
    const publishedOutcome = await publishOutboxRow(
      mockPrisma as any,
      retryRow
    );
    expect(publishedOutcome).toBe("published");
  });

  it("quarantines a row that exceeds QUARANTINE_ATTEMPTS_THRESHOLD (default 10)", async () => {
    vi.mocked(settlementQueue.enqueue).mockRejectedValue(
      new Error("permanently broken")
    );

    const failedRow: OutboxRow = { ...row, attempts: 9 };
    const outcome = await publishOutboxRow(mockPrisma as any, failedRow);

    expect(outcome).toBe("quarantined");
    expect(mockPrisma.outboxEvent.updateMany).toHaveBeenCalledWith({
      where: { tradeId: "trade-1", status: { not: "PUBLISHED" } },
      data: {
        status: "QUARANTINED",
        attempts: 10,
        lastError: expect.stringContaining("permanently broken"),
        quarantinedAt: expect.any(Date),
      },
    });
  });
});

describe("drainOutboxOnce", () => {
  let mockPrisma: ReturnType<typeof makeMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = makeMockPrisma();
  });

  it("publishes every due row and reports counts", async () => {
    const trades = [makeTrade({ id: "trade-1" }), makeTrade({ id: "trade-2" })];
    mockPrisma.outboxEvent.findMany.mockResolvedValue(
      trades.map((t) => ({
        tradeId: t.id,
        payload: buildSettlementPayload(t),
        attempts: 0,
        status: "PENDING",
      }))
    );
    vi.mocked(settlementQueue.enqueue).mockResolvedValue(undefined);

    const result = await drainOutboxOnce(mockPrisma as any, 10);

    expect(result).toEqual({ published: 2, failed: 0 });
    expect(settlementQueue.enqueue).toHaveBeenCalledTimes(2);
  });

  it("continues draining remaining rows when one row fails to publish", async () => {
    mockPrisma.outboxEvent.findMany.mockResolvedValue([
      {
        tradeId: "trade-1",
        payload: buildSettlementPayload(makeTrade({ id: "trade-1" })),
        attempts: 0,
        status: "PENDING",
      },
      {
        tradeId: "trade-2",
        payload: buildSettlementPayload(makeTrade({ id: "trade-2" })),
        attempts: 0,
        status: "PENDING",
      },
    ]);
    vi.mocked(settlementQueue.enqueue)
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce(undefined);

    const result = await drainOutboxOnce(mockPrisma as any, 10);

    expect(result).toEqual({ published: 1, failed: 1 });
  });

  it("duplicate drain of the same batch (two publisher instances racing) is safe and idempotent", async () => {
    const row = {
      tradeId: "trade-1",
      payload: buildSettlementPayload(makeTrade()),
      attempts: 0,
      status: "PENDING",
    };
    mockPrisma.outboxEvent.findMany.mockResolvedValue([row]);
    vi.mocked(settlementQueue.enqueue).mockResolvedValue(undefined);

    const [first, second] = await Promise.all([
      drainOutboxOnce(mockPrisma as any, 10),
      drainOutboxOnce(mockPrisma as any, 10),
    ]);

    // Both drains see the same PENDING row (neither has claimed it yet) and
    // both successfully publish — enqueue is called twice, which is
    // acceptable because settlementQueue delivery is at-least-once and the
    // downstream settlement consumer idempotency-checks on tradeId (#870).
    expect(first.published).toBe(1);
    expect(second.published).toBe(1);
    expect(settlementQueue.enqueue).toHaveBeenCalledTimes(2);
    // Never throws, never reports a hard failure for a duplicate.
    expect(first.failed).toBe(0);
    expect(second.failed).toBe(0);
  });

  it("only selects rows past their backoff window", async () => {
    mockPrisma.outboxEvent.findMany.mockResolvedValue([]);

    await drainOutboxOnce(mockPrisma as any, 10);

    expect(mockPrisma.outboxEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["PENDING", "FAILED"] },
          nextAttemptAt: { lte: expect.any(Date) },
        },
      })
    );
  });
});

describe("refreshOutboxMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets depth, lag, orphaned, and quarantined gauges from current DB state", async () => {
    const mockPrisma = makeMockPrisma();
    mockPrisma.outboxEvent.count
      .mockResolvedValueOnce(7) // depth
      .mockResolvedValueOnce(2) // orphaned
      .mockResolvedValueOnce(1); // quarantined
    const oldest = new Date(Date.now() - 5_000);
    mockPrisma.outboxEvent.findFirst.mockResolvedValue({ createdAt: oldest });

    await refreshOutboxMetrics(mockPrisma as any);

    expect(settlementOutboxDepthGauge.set).toHaveBeenCalledWith(7);
    expect(settlementOutboxOrphanedTradesGauge.set).toHaveBeenCalledWith(2);
    expect(
      vi.mocked(settlementOutboxQuarantinedEntriesGauge.set)
    ).toHaveBeenCalledWith(1);
    const [lagValue] = vi.mocked(settlementOutboxLagSecondsGauge.set).mock
      .calls[0];
    expect(lagValue).toBeGreaterThanOrEqual(4);
    expect(lagValue).toBeLessThan(10);
  });

  it("reports zero lag when there are no unpublished rows", async () => {
    const mockPrisma = makeMockPrisma();

    await refreshOutboxMetrics(mockPrisma as any);

    expect(settlementOutboxLagSecondsGauge.set).toHaveBeenCalledWith(0);
  });
});
