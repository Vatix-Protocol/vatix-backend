import { describe, it, expect, beforeEach, vi } from "vitest";
import { fillsResumeService } from "./fills-resume.js";
import { redis } from "./redis.js";
import { getPrismaClient } from "./prisma.js";

const mockPrisma = {
  trade: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
  },
};

vi.mock("./redis.js", () => ({
  redis: {
    xrange: vi.fn(),
    xrevrange: vi.fn(),
  },
}));

vi.mock("./prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

describe("FillsResumeService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseCursor", () => {
    it("should parse stream ID format", () => {
      const cursor = fillsResumeService.parseCursor("1234567890-0");
      expect(cursor).toBe("1234567890-0");
    });

    it("should parse ISO timestamp and convert to stream ID", () => {
      const isoTime = "2026-07-29T12:00:00.000Z";
      const cursor = fillsResumeService.parseCursor(isoTime);
      expect(cursor).toBeDefined();
      expect(cursor).toMatch(/^\d+-0$/);
    });

    it("should return null for invalid cursor", () => {
      const cursor = fillsResumeService.parseCursor("invalid");
      expect(cursor).toBeNull();
    });

    it("should handle undefined cursor", () => {
      const cursor = fillsResumeService.parseCursor(undefined);
      expect(cursor).toBeNull();
    });
  });

  describe("detectGap", () => {
    it("should detect valid cursor (no gap)", async () => {
      vi.mocked(redis.xrange).mockResolvedValue([
        ["1234567890-0", ["tradeId", "123", "outcome", "YES"]],
      ]);

      const result = await fillsResumeService.detectGap("1234567890-0");

      expect(result.hasGap).toBe(false);
    });

    it("should detect trimmed cursor (cursor before oldest)", async () => {
      vi.mocked(redis.xrange).mockResolvedValue([]); // Cursor not found
      vi.mocked(redis.xrevrange).mockResolvedValue([
        ["1234567900-0", ["data"]],
      ]); // Get latest
      vi.mocked(redis.xrange)
        .mockResolvedValueOnce([]) // First xrange (check cursor)
        .mockResolvedValueOnce([
          ["1234567900-0", ["data"]],
        ]); // Second xrange (get oldest)

      // Override mock for sequence: check cursor, get oldest
      let callCount = 0;
      vi.mocked(redis.xrange).mockImplementation(async (key, start, end) => {
        if (start === "1234567890-0" && end === "1234567890-0") {
          // Looking for specific cursor
          return [];
        }
        if (start === "-" && end === "+") {
          // Getting oldest
          return [["1234567900-0", ["data"]]];
        }
        return [];
      });

      const result = await fillsResumeService.detectGap("1234567890-0");

      expect(result.hasGap).toBe(true);
      expect(result.reason).toBe("cursor_trimmed");
    });

    it("should detect unknown cursor", async () => {
      vi.mocked(redis.xrange).mockResolvedValue([]); // Cursor not found
      vi.mocked(redis.xrevrange).mockResolvedValue([]); // Stream empty

      const result = await fillsResumeService.detectGap("unknown-cursor");

      expect(result.hasGap).toBe(true);
      expect(result.reason).toBe("cursor_unknown");
    });
  });

  describe("getTradesAfterCursor", () => {
    it("should retrieve trades after cursor", async () => {
      const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DU";
      const cursor = "1234567890000-0";

      const mockTrades = [
        {
          tradeId: "trade1",
          marketId: "market1",
          outcome: "YES",
          buyerAddress: wallet,
          sellerAddress: "other",
          buyOrderId: "order1",
          sellOrderId: "order2",
          price: 0.5,
          quantity: 10,
          tradedAt: new Date("2026-07-29T12:01:00Z"),
        },
      ];

      mockPrisma.trade.findMany.mockResolvedValue(mockTrades);

      const result = await fillsResumeService.getTradesAfterCursor(
        wallet,
        cursor,
        100
      );

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].tradeId).toBe("trade1");
      expect(result.trades[0].side).toBe("BUY");
      expect(result.lastCursor).toBeDefined();
    });

    it("should return empty array if no trades", async () => {
      const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DU";
      const cursor = "1234567890000-0";

      mockPrisma.trade.findMany.mockResolvedValue([]);

      const result = await fillsResumeService.getTradesAfterCursor(
        wallet,
        cursor,
        100
      );

      expect(result.trades).toHaveLength(0);
      expect(result.lastCursor).toBe(cursor);
    });
  });

  describe("getReplayBounds", () => {
    it("should return replay bounds for wallet", async () => {
      const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DU";

      mockPrisma.trade.findFirst
        .mockResolvedValueOnce({ tradedAt: new Date("2026-07-29T12:00:00Z") }) // First
        .mockResolvedValueOnce({ tradedAt: new Date("2026-07-29T12:05:00Z") }); // Last

      mockPrisma.trade.count.mockResolvedValue(42);

      const bounds = await fillsResumeService.getReplayBounds(wallet);

      expect(bounds.minCursor).toBeDefined();
      expect(bounds.maxCursor).toBeDefined();
      expect(bounds.recordCount).toBe(42);
    });

    it("should handle empty wallet history", async () => {
      const wallet = "GAWBT2Z5XMLMNRXA5TERUYRMKANZIA5CZSYPU3AVQLTIRONQOXLA5DU";

      mockPrisma.trade.findFirst.mockResolvedValue(null);
      mockPrisma.trade.count.mockResolvedValue(0);

      const bounds = await fillsResumeService.getReplayBounds(wallet);

      expect(bounds.minCursor).toBeNull();
      expect(bounds.maxCursor).toBeNull();
      expect(bounds.recordCount).toBe(0);
    });
  });
});
