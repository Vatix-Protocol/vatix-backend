import { describe, it, expect, beforeEach, vi } from "vitest";
import { ReconciliationJob } from "./job.js";
import { positionReconciliationService } from "../../../src/services/position-reconciliation.js";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type ILogger from "../../../packages/shared/src/logger.js";

const mockLogger: ILogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const mockPrisma = {
  market: {
    findMany: vi.fn(),
  },
};

vi.mock("../../../src/services/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

vi.mock("../../../src/services/position-reconciliation.js");

describe("ReconciliationJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should handle empty market list", async () => {
    mockPrisma.market.findMany.mockResolvedValue([]);

    const job = new ReconciliationJob(mockLogger, 20000, false);
    const result = await job.run();

    expect(result.success).toBe(true);
    expect(result.totalMarkets).toBe(0);
    expect(result.completedMarkets).toBe(0);
  });

  it("should reconcile multiple markets", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market1" },
      { id: "market2" },
    ]);

    vi.mocked(
      positionReconciliationService.reconcileMarket
    ).mockResolvedValue({
      marketId: "market1",
      totalWallets: 5,
      driftCount: 1,
      recoveredCount: 1,
      failedCount: 0,
      duration: 100,
    });

    const job = new ReconciliationJob(mockLogger, 20000, false);
    const result = await job.run();

    expect(result.totalMarkets).toBe(2);
    expect(result.completedMarkets).toBe(2);
  });

  it("should respect maxRunMs timeout", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market1" },
      { id: "market2" },
      { id: "market3" },
    ]);

    let callCount = 0;
    vi.mocked(
      positionReconciliationService.reconcileMarket
    ).mockImplementation(async () => {
      callCount++;
      // Simulate long-running reconciliation
      await new Promise((r) => setTimeout(r, 100));
      return {
        marketId: `market${callCount}`,
        totalWallets: 5,
        driftCount: 0,
        recoveredCount: 0,
        failedCount: 0,
        duration: 100,
      };
    });

    const job = new ReconciliationJob(mockLogger, 150, false);
    const result = await job.run();

    expect(result.completedMarkets).toBeLessThan(3);
  });

  it("should handle reconciliation errors", async () => {
    mockPrisma.market.findMany.mockResolvedValue([
      { id: "market1" },
      { id: "market2" },
    ]);

    vi.mocked(positionReconciliationService.reconcileMarket)
      .mockResolvedValueOnce({
        marketId: "market1",
        totalWallets: 5,
        driftCount: 0,
        recoveredCount: 0,
        failedCount: 0,
        duration: 100,
      })
      .mockRejectedValueOnce(new Error("Database error"));

    const job = new ReconciliationJob(mockLogger, 20000, false);
    const result = await job.run();

    expect(result.failedMarkets).toBe(1);
    expect(result.completedMarkets).toBe(1);
  });
});
