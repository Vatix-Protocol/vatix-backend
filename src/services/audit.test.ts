import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { auditService } from "./audit";
import { redis } from "./redis";
import type { Trade } from "../matching/engine";

describe("Audit Service", () => {
  const testMarketId = "test-market-123";
  const testTrade: Trade = {
    id: "trade-1",
    marketId: testMarketId,
    outcome: "YES",
    buyerAddress: "GBUYER1234567890123456789012345678901234567890123456",
    sellerAddress: "GSELLER234567890123456789012345678901234567890123456",
    buyOrderId: "buy-order-1",
    sellOrderId: "sell-order-1",
    price: 0.55,
    quantity: 100,
    timestamp: Date.now(),
  };

  beforeEach(async () => {
    // Clean up test streams
    try {
      await redis.del(`audit:market:${testMarketId}`);
      await redis.del("audit:trades:global");
    } catch (error) {
      // Streams might not exist
    }
  });

  afterAll(async () => {
    await redis.disconnect();
  });

  describe("logOrderMatch", () => {
    it("should log trade to audit stream", async () => {
      const entryId = await auditService.logOrderMatch(testTrade);

      expect(entryId).toBeDefined();
      expect(entryId).toMatch(/^\d+-\d+$/); // Format: timestamp-sequence
    });

    it("should log to both market and global streams", async () => {
      await auditService.logOrderMatch(testTrade);

      const marketLogs = await auditService.getAuditLog(testMarketId, 10);
      const globalLogs = await auditService.getRecentTrades(10);

      expect(marketLogs.length).toBe(1);
      expect(globalLogs.length).toBe(1);
    });

    it("should complete in under 5ms", async () => {
      const start = performance.now();
      await auditService.logOrderMatch(testTrade);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(5);
    });

    it("should preserve all trade data", async () => {
      await auditService.logOrderMatch(testTrade);

      const logs = await auditService.getAuditLog(testMarketId, 1);
      const entry = logs[0];

      expect(entry.trade.id).toBe(testTrade.id);
      expect(entry.trade.marketId).toBe(testTrade.marketId);
      expect(entry.trade.outcome).toBe(testTrade.outcome);
      expect(entry.trade.buyerAddress).toBe(testTrade.buyerAddress);
      expect(entry.trade.sellerAddress).toBe(testTrade.sellerAddress);
      expect(entry.trade.price).toBe(testTrade.price);
      expect(entry.trade.quantity).toBe(testTrade.quantity);
    });
  });

  describe("getAuditLog", () => {
    it("should return empty array for market with no trades", async () => {
      const logs = await auditService.getAuditLog("non-existent-market");
      expect(logs).toEqual([]);
    });

    it("should return trades in chronological order", async () => {
      const trade1 = { ...testTrade, id: "trade-1", timestamp: 1000 };
      const trade2 = { ...testTrade, id: "trade-2", timestamp: 2000 };
      const trade3 = { ...testTrade, id: "trade-3", timestamp: 3000 };

      await auditService.logOrderMatch(trade1);
      await auditService.logOrderMatch(trade2);
      await auditService.logOrderMatch(trade3);

      const logs = await auditService.getAuditLog(testMarketId, 10);

      expect(logs.length).toBe(3);
      expect(logs[0].trade.id).toBe("trade-1");
      expect(logs[1].trade.id).toBe("trade-2");
      expect(logs[2].trade.id).toBe("trade-3");
    });

    it("should respect limit parameter", async () => {
      for (let i = 0; i < 10; i++) {
        await auditService.logOrderMatch({
          ...testTrade,
          id: `trade-${i}`,
        });
      }

      const logs = await auditService.getAuditLog(testMarketId, 5);
      expect(logs.length).toBe(5);
    });
  });

  describe("getRecentTrades", () => {
    it("should return trades from all markets", async () => {
      const trade1 = { ...testTrade, marketId: "market-1" };
      const trade2 = { ...testTrade, marketId: "market-2" };

      await auditService.logOrderMatch(trade1);
      await auditService.logOrderMatch(trade2);

      const logs = await auditService.getRecentTrades(10);

      expect(logs.length).toBe(2);
      const marketIds = logs.map((l) => l.trade.marketId);
      expect(marketIds).toContain("market-1");
      expect(marketIds).toContain("market-2");
    });

    it("should return newest trades first", async () => {
      const trade1 = { ...testTrade, id: "trade-1", timestamp: 1000 };
      const trade2 = { ...testTrade, id: "trade-2", timestamp: 2000 };

      await auditService.logOrderMatch(trade1);
      await auditService.logOrderMatch(trade2);

      const logs = await auditService.getRecentTrades(10);

      expect(logs[0].trade.id).toBe("trade-2"); // Newest first
      expect(logs[1].trade.id).toBe("trade-1");
    });
  });

  describe("getAuditLogRange", () => {
    it("should return trades within time range", async () => {
      const trade1 = { ...testTrade, id: "trade-1", timestamp: 1000 };
      const trade2 = { ...testTrade, id: "trade-2", timestamp: 2000 };
      const trade3 = { ...testTrade, id: "trade-3", timestamp: 3000 };

      await auditService.logOrderMatch(trade1);
      await auditService.logOrderMatch(trade2);
      await auditService.logOrderMatch(trade3);

      const logs = await auditService.getAuditLogRange(
        testMarketId,
        1500,
        2500
      );

      expect(logs.length).toBe(1);
      expect(logs[0].trade.id).toBe("trade-2");
    });

    it("should return empty array when no trades in range", async () => {
      await auditService.logOrderMatch(testTrade);

      const logs = await auditService.getAuditLogRange(
        testMarketId,
        9999999999999,
        9999999999999
      );

      expect(logs).toEqual([]);
    });
  });

  describe("getAuditLogStats", () => {
    it("should return zero stats for empty stream", async () => {
      const stats = await auditService.getAuditLogStats("non-existent");

      expect(stats.totalEntries).toBe(0);
      expect(stats.oldestEntry).toBeNull();
      expect(stats.newestEntry).toBeNull();
    });

    it("should return correct stats after logging trades", async () => {
      await auditService.logOrderMatch(testTrade);
      await auditService.logOrderMatch({ ...testTrade, id: "trade-2" });

      const stats = await auditService.getAuditLogStats(testMarketId);

      expect(stats.totalEntries).toBe(2);
      expect(stats.oldestEntry).toBeDefined();
      expect(stats.newestEntry).toBeDefined();
    });
  });

  describe("Immutability", () => {
    it("should not allow modification of logged entries", async () => {
      const entryId = await auditService.logOrderMatch(testTrade);

      // Redis Streams are append-only, entries cannot be modified
      // This test verifies we only have read operations
      const logs = await auditService.getAuditLog(testMarketId, 1);

      expect(logs[0].id).toBe(entryId);
      expect(logs[0].trade.price).toBe(0.55);

      // Even if we try to log same trade with different price, it's a new entry
      await auditService.logOrderMatch({ ...testTrade, price: 0.99 });

      const allLogs = await auditService.getAuditLog(testMarketId, 10);
      expect(allLogs.length).toBe(2);
      expect(allLogs[0].trade.price).toBe(0.55); // Original unchanged
      expect(allLogs[1].trade.price).toBe(0.99); // New entry
    });
  });
});
