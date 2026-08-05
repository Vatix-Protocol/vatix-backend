import { describe, it, expect, beforeEach, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import { PositionReconciliationService } from "./position-reconciliation.js";
import { getPrismaClient } from "./prisma.js";

const mockPrisma = {
  userPosition: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  indexedTrade: {
    findMany: vi.fn(),
  },
  collateralDeposit: {
    findMany: vi.fn(),
  },
  positionReconciliationJob: {
    create: vi.fn(),
  },
  depositReconciliation: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    count: vi.fn(),
  },
  market: {
    findMany: vi.fn(),
  },
  $transaction: vi.fn((fn) => fn(mockPrisma)),
};

vi.mock("./prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

describe("PositionReconciliationService", () => {
  let service: PositionReconciliationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PositionReconciliationService();
  });

  describe("reconcile", () => {
    it("should detect no drift when position matches events", async () => {
      const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DU";
      const marketId = "market123";

      mockPrisma.userPosition.findUnique.mockResolvedValue({
        marketId,
        userAddress: wallet,
        yesShares: 10,
        noShares: 0,
        lockedCollateral: new Decimal("100"),
      });

      mockPrisma.indexedTrade.findMany.mockResolvedValue([
        {
          traderAddress: wallet,
          counterpartyAddress: "other",
          direction: "BUY",
          outcome: "YES",
          quantityRaw: "10",
        },
      ]);

      mockPrisma.collateralDeposit.findMany.mockResolvedValue([
        {
          account: wallet,
          // 100 * 10^7 collateral scale units
          amountRaw: "1000000000",
        },
      ]);

      const result = await service.reconcile(wallet, marketId, false);

      expect(result.hasDrift).toBe(false);
      expect(result.divergence).toBeNull();
      expect(result.recovered).toBe(false);
    });

    it("should detect drift when position differs from events", async () => {
      const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DU";
      const marketId = "market123";

      mockPrisma.userPosition.findUnique.mockResolvedValue({
        marketId,
        userAddress: wallet,
        yesShares: 5, // Should be 10
        noShares: 0,
        lockedCollateral: new Decimal("100"),
      });

      mockPrisma.indexedTrade.findMany.mockResolvedValue([
        {
          traderAddress: wallet,
          counterpartyAddress: "other",
          direction: "BUY",
          outcome: "YES",
          quantityRaw: "10",
        },
      ]);

      mockPrisma.collateralDeposit.findMany.mockResolvedValue([
        {
          account: wallet,
          amountRaw: "100",
        },
      ]);

      const result = await service.reconcile(wallet, marketId, false);

      expect(result.hasDrift).toBe(true);
      expect(result.divergence).toBeDefined();
      expect(result.divergence?.divergence.yesSharesDiff).toBe(5);
      expect(result.recovered).toBe(false);
    });

    it("should apply recovery when autoRecovery=true", async () => {
      const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DU";
      const marketId = "market123";

      mockPrisma.userPosition.findUnique.mockResolvedValue({
        marketId,
        userAddress: wallet,
        yesShares: 5, // Should be 10
        noShares: 0,
        lockedCollateral: new Decimal("100"),
      });

      mockPrisma.indexedTrade.findMany.mockResolvedValue([
        {
          traderAddress: wallet,
          counterpartyAddress: "other",
          direction: "BUY",
          outcome: "YES",
          quantityRaw: "10",
        },
      ]);

      mockPrisma.collateralDeposit.findMany.mockResolvedValue([
        {
          account: wallet,
          amountRaw: "100",
        },
      ]);

      mockPrisma.userPosition.update.mockResolvedValue({
        marketId,
        userAddress: wallet,
        yesShares: 10,
        noShares: 0,
        lockedCollateral: new Decimal("100"),
      });

      const result = await service.reconcile(wallet, marketId, true);

      expect(result.hasDrift).toBe(true);
      expect(result.recovered).toBe(true);
      expect(mockPrisma.userPosition.update).toHaveBeenCalled();
    });

    it("should create position if it doesn't exist", async () => {
      const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DU";
      const marketId = "market123";

      mockPrisma.userPosition.findUnique.mockResolvedValue(null);

      mockPrisma.indexedTrade.findMany.mockResolvedValue([
        {
          traderAddress: wallet,
          counterpartyAddress: "other",
          direction: "BUY",
          outcome: "YES",
          quantityRaw: "10",
        },
      ]);

      mockPrisma.collateralDeposit.findMany.mockResolvedValue([
        {
          account: wallet,
          amountRaw: "1000000000",
        },
      ]);

      const result = await service.reconcile(wallet, marketId, true);

      expect(result.hasDrift).toBe(true);
      expect(result.recovered).toBe(true);
      expect(mockPrisma.userPosition.create).toHaveBeenCalledWith({
        data: {
          marketId,
          userAddress: wallet,
          yesShares: 10,
          noShares: 0,
          lockedCollateral: new Decimal("100"),
        },
      });
    });
  });
});
