import { describe, it, expect, beforeEach, vi } from "vitest";
import { LagDetector } from "./lag-detector.js";
import { redis } from "./redis.js";
import { getPrismaClient } from "./prisma.js";

const mockPrisma = {
  outboxEvent: {
    count: vi.fn(),
  },
};

vi.mock("./redis.js", () => ({
  redis: {
    xlen: vi.fn(),
    zcard: vi.fn(),
  },
}));

vi.mock("./prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

describe("LagDetector", () => {
  let detector: LagDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new LagDetector({
      highWaterMark: 1000,
      lowWaterMark: 500,
    });
  });

  describe("getSettlementQueueDepth", () => {
    it("should read queue depth from BullMQ", async () => {
      vi.mocked(redis.zcard).mockResolvedValue(150);

      const depth = await detector.getSettlementQueueDepth();

      expect(depth).toBe(150);
    });

    it("should fall back to Redis stream XLEN", async () => {
      vi.mocked(redis.zcard).mockRejectedValue(new Error("Not a BullMQ queue"));
      vi.mocked(redis.xlen).mockResolvedValue(200);

      const depth = await detector.getSettlementQueueDepth();

      expect(depth).toBe(200);
    });

    it("should return 0 on error", async () => {
      vi.mocked(redis.zcard).mockRejectedValue(new Error("Redis error"));
      vi.mocked(redis.xlen).mockRejectedValue(new Error("Redis error"));

      const depth = await detector.getSettlementQueueDepth();

      expect(depth).toBe(0);
    });
  });

  describe("getOutboxUnpublishedCount", () => {
    it("should count unpublished outbox events", async () => {
      mockPrisma.outboxEvent.count.mockResolvedValue(50);

      const count = await detector.getOutboxUnpublishedCount();

      expect(count).toBe(50);
    });

    it("should return 0 if table does not exist (P2021)", async () => {
      const err = Object.assign(new Error("Table not found"), { code: "P2021" });
      mockPrisma.outboxEvent.count.mockRejectedValue(err);

      const count = await detector.getOutboxUnpublishedCount();

      expect(count).toBe(0);
    });

    it("should return 0 if column does not exist (P2022)", async () => {
      const err = Object.assign(new Error("Column not found"), { code: "P2022" });
      mockPrisma.outboxEvent.count.mockRejectedValue(err);

      const count = await detector.getOutboxUnpublishedCount();

      expect(count).toBe(0);
    });

    it("should rethrow non-missing-table errors", async () => {
      const err = Object.assign(new Error("connection refused"), {
        code: "P1001",
      });
      mockPrisma.outboxEvent.count.mockRejectedValue(err);

      await expect(detector.getOutboxUnpublishedCount()).rejects.toThrow(
        "connection refused"
      );
    });
  });

  describe("getMetrics and shedding state", () => {
    it("should not shed when lag is below high water mark", async () => {
      vi.mocked(redis.zcard).mockResolvedValue(500);
      mockPrisma.outboxEvent.count.mockResolvedValue(0);

      const metrics = await detector.getMetrics();

      expect(metrics.totalLag).toBe(500);
      expect(metrics.shedding).toBe(false);
    });

    it("should shed when lag exceeds high water mark", async () => {
      vi.mocked(redis.zcard).mockResolvedValue(1500);
      mockPrisma.outboxEvent.count.mockResolvedValue(0);

      const metrics = await detector.getMetrics();

      expect(metrics.totalLag).toBe(1500);
      expect(metrics.shedding).toBe(true);
    });

    it("should implement hysteresis: recover at low water mark", async () => {
      // First, trigger shedding
      vi.mocked(redis.zcard).mockResolvedValue(1500);
      mockPrisma.outboxEvent.count.mockResolvedValue(0);

      let metrics = await detector.getMetrics();
      expect(metrics.shedding).toBe(true);

      // Then, drop below low water mark
      vi.mocked(redis.zcard).mockResolvedValue(300);
      metrics = await detector.getMetrics();

      expect(metrics.totalLag).toBe(300);
      expect(metrics.shedding).toBe(false);
    });

    it("should weight settlement queue and outbox in lag calculation", async () => {
      vi.mocked(redis.zcard).mockResolvedValue(500); // 500 * 1.0 = 500
      mockPrisma.outboxEvent.count.mockResolvedValue(200); // 200 * 0.5 = 100

      const metrics = await detector.getMetrics();

      expect(metrics.settlementQueueDepth).toBe(500);
      expect(metrics.outboxUnpublishedCount).toBe(200);
      expect(metrics.totalLag).toBe(600); // 500 + 100
    });

    it("should force shedding when outbox read fails with a generic error", async () => {
      vi.mocked(redis.zcard).mockResolvedValue(0);
      mockPrisma.outboxEvent.count.mockRejectedValue(
        Object.assign(new Error("connection refused"), { code: "P1001" })
      );

      const metrics = await detector.getMetrics();

      expect(metrics.shedding).toBe(true);
    });

    it("should not shed when outbox table is missing (P2021)", async () => {
      vi.mocked(redis.zcard).mockResolvedValue(0);
      mockPrisma.outboxEvent.count.mockRejectedValue(
        Object.assign(new Error("Table not found"), { code: "P2021" })
      );

      const metrics = await detector.getMetrics();

      expect(metrics.outboxUnpublishedCount).toBe(0);
      expect(metrics.shedding).toBe(false);
    });
  });

  describe("shouldShed", () => {
    it("should return shedding state", async () => {
      vi.mocked(redis.zcard).mockResolvedValue(2000);
      mockPrisma.outboxEvent.count.mockResolvedValue(0);

      const shouldShed = await detector.shouldShed();

      expect(shouldShed).toBe(true);
    });
  });

  describe("resetShedState", () => {
    it("should manually reset shedding state", async () => {
      vi.mocked(redis.zcard).mockResolvedValue(1500);
      mockPrisma.outboxEvent.count.mockResolvedValue(0);

      let metrics = await detector.getMetrics();
      expect(metrics.shedding).toBe(true);

      detector.resetShedState();

      // After reset, even with high lag, we should read fresh state
      vi.mocked(redis.zcard).mockResolvedValue(1500);
      metrics = await detector.getMetrics();
      expect(metrics.shedding).toBe(true); // Back to shedding since lag is still high
    });
  });
});
