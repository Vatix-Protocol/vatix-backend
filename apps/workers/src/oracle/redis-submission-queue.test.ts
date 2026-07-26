/**
 * Redis Submission Queue Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { RedisSubmissionQueue } from "./redis-submission-queue.js";
import type { SubmissionQueueItem } from "../../../oracle/submission-queue.js";

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
};

// Mock Redis client
const createMockRedisClient = () => ({
  xgroup: vi.fn(),
  xadd: vi.fn(),
  exists: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  xreadgroup: vi.fn(),
  xack: vi.fn(),
  xclaim: vi.fn(),
});

describe("RedisSubmissionQueue", () => {
  let queue: RedisSubmissionQueue;
  let mockClient: any;

  beforeEach(() => {
    mockClient = createMockRedisClient();
    queue = new RedisSubmissionQueue({
      redisClient: mockClient,
      visibilityTimeoutMs: 5000,
      logger: mockLogger,
      // Explicit prefix so tests are deterministic and independent of env
      keyPrefix: "test:",
    });
    vi.clearAllMocks();
  });

  describe("initialize", () => {
    it("should create consumer group on first init", async () => {
      mockClient.xgroup.mockResolvedValueOnce(undefined);

      await queue.initialize();

      expect(mockClient.xgroup).toHaveBeenCalledWith(
        "CREATE",
        "test:oracle:submissions",
        "oracle-worker",
        "$",
        { MKSTREAM: true }
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Oracle submission queue initialized",
        expect.any(Object)
      );
    });

    it("should handle existing consumer group gracefully", async () => {
      mockClient.xgroup.mockRejectedValueOnce(
        new Error("BUSYGROUP group already exists")
      );

      await queue.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Consumer group already exists",
        expect.any(Object)
      );
    });

    it("should propagate other errors", async () => {
      mockClient.xgroup.mockRejectedValueOnce(new Error("Redis error"));

      await expect(queue.initialize()).rejects.toThrow("Redis error");
    });

    it("should use REDIS_KEY_PREFIX env var when no keyPrefix is provided in config", async () => {
      vi.stubEnv("REDIS_KEY_PREFIX", "myenv:");
      const envQueue = new RedisSubmissionQueue({
        redisClient: mockClient,
        visibilityTimeoutMs: 5000,
        logger: mockLogger,
        // keyPrefix intentionally omitted — should pick up REDIS_KEY_PREFIX
      });
      mockClient.xgroup.mockResolvedValueOnce(undefined);
      await envQueue.initialize();
      expect(mockClient.xgroup).toHaveBeenCalledWith(
        "CREATE",
        "myenv:oracle:submissions",
        "oracle-worker",
        "$",
        { MKSTREAM: true }
      );
      vi.unstubAllEnvs();
    });

    it("should fall back to vatix: prefix when REDIS_KEY_PREFIX is not set", async () => {
      vi.stubEnv("REDIS_KEY_PREFIX", "");
      const noEnvQueue = new RedisSubmissionQueue({
        redisClient: mockClient,
        visibilityTimeoutMs: 5000,
        logger: mockLogger,
      });
      mockClient.xgroup.mockResolvedValueOnce(undefined);
      await noEnvQueue.initialize();
      expect(mockClient.xgroup).toHaveBeenCalledWith(
        "CREATE",
        "vatix:oracle:submissions",
        "oracle-worker",
        "$",
        { MKSTREAM: true }
      );
      vi.unstubAllEnvs();
    });
  });

  describe("enqueue", () => {
    const testItem: SubmissionQueueItem = {
      id: "test-123",
      request: {
        marketId: "market-1",
        oracleAddress: "G123456789",
      },
      result: {
        outcome: true,
        source: "Chainlink",
        signature: "sig123",
        publicKey: "pk123",
        confidence: 0.9,
        confidenceMetadata: { score: 0.9, method: "test" },
        sourceMetadata: { provider: "Chainlink" },
        timestamp: "2024-01-01T00:00:00Z",
      },
      status: "pending",
      enqueuedAt: "2024-01-01T00:00:00Z",
      attempts: 0,
    };

    it("should enqueue item and set both dedup flags", async () => {
      mockClient.exists
        .mockResolvedValueOnce(0) // Not already queued (content hash)
        .mockResolvedValueOnce(0); // No in-flight submission for this market
      mockClient.xadd.mockResolvedValueOnce("1-0"); // Stream ID
      mockClient.set.mockResolvedValueOnce("OK").mockResolvedValueOnce("OK");

      const result = await queue.enqueue(testItem);

      expect(result).toBe(true);
      expect(mockClient.xadd).toHaveBeenCalledWith(
        "test:oracle:submissions",
        "*",
        "payload",
        expect.any(String),
        "marketId",
        "market-1",
        "payloadHash",
        expect.any(String)
      );
      expect(mockClient.set).toHaveBeenCalledWith(
        expect.stringContaining("oracle:dedup:market-1:"),
        "1-0",
        "EX",
        86400
      );
      expect(mockClient.set).toHaveBeenCalledWith(
        "oracle:inflight:market-1",
        "1-0",
        "EX",
        86400
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Oracle submission queued",
        expect.any(Object)
      );
    });

    it("should skip duplicate payloads", async () => {
      mockClient.exists.mockResolvedValueOnce(1); // Already queued

      const result = await queue.enqueue(testItem);

      expect(result).toBe(false);
      expect(mockClient.xadd).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Submission already queued, skipping duplicate",
        expect.any(Object)
      );
    });

    it("should skip enqueue when the market already has an in-flight submission", async () => {
      mockClient.exists
        .mockResolvedValueOnce(0) // No duplicate payload
        .mockResolvedValueOnce(1); // Market already has one in flight

      const result = await queue.enqueue(testItem);

      expect(result).toBe(false);
      expect(mockClient.exists).toHaveBeenNthCalledWith(
        2,
        "oracle:inflight:market-1"
      );
      expect(mockClient.xadd).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Market already has an in-flight submission, skipping duplicate",
        expect.any(Object)
      );
    });
  });

  describe("dequeue", () => {
    it("should return null when no messages", async () => {
      mockClient.xreadgroup.mockResolvedValueOnce(null);

      const result = await queue.dequeue("consumer-1");

      expect(result).toBeNull();
    });

    it("should dequeue and parse message", async () => {
      const testItem: SubmissionQueueItem = {
        id: "test-123",
        request: { marketId: "m1", oracleAddress: "G123" },
        result: {
          outcome: true,
          source: "Test",
          signature: "s1",
          publicKey: "p1",
          confidence: 0.8,
          confidenceMetadata: { score: 0.8, method: "test" },
          sourceMetadata: { provider: "Test" },
          timestamp: "2024-01-01T00:00:00Z",
        },
        status: "pending",
        enqueuedAt: "2024-01-01T00:00:00Z",
        attempts: 0,
      };

      mockClient.xreadgroup.mockResolvedValueOnce([
        [
          "oracle:submissions",
          [
            [
              "1-0",
              {
                payload: JSON.stringify(testItem),
                marketId: "m1",
              },
            ],
          ],
        ],
      ]);

      const result = await queue.dequeue("consumer-1");

      expect(result).toBeDefined();
      expect(result?.streamId).toBe("1-0");
      expect(result?.visibilityExpiresAt).toBeGreaterThan(Date.now());
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Dequeued submission from Redis stream",
        expect.any(Object)
      );
    });
  });

  describe("acknowledge", () => {
    it("should acknowledge processed message and release the market lock", async () => {
      mockClient.xack.mockResolvedValueOnce(1);
      mockClient.del.mockResolvedValueOnce(1);

      const item = {
        id: "test-123",
        request: { marketId: "m1", oracleAddress: "G123" },
        result: {
          outcome: true,
          source: "Test",
          signature: "s1",
          publicKey: "p1",
          confidence: 0.8,
          confidenceMetadata: { score: 0.8, method: "test" },
          sourceMetadata: { provider: "Test" },
          timestamp: "2024-01-01T00:00:00Z",
        },
        status: "pending" as const,
        enqueuedAt: "2024-01-01T00:00:00Z",
        attempts: 0,
        streamId: "1-0",
        visibilityExpiresAt: Date.now() + 5000,
      };

      await queue.acknowledge(item);

      expect(mockClient.xack).toHaveBeenCalledWith(
        "test:oracle:submissions",
        "oracle-worker",
        "1-0"
      );
      expect(mockClient.del).toHaveBeenCalledWith("oracle:inflight:m1");
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Acknowledged oracle submission",
        expect.any(Object)
      );
    });
  });

  describe("nack", () => {
    it("should nack message for retry using the given consumer name", async () => {
      mockClient.xclaim.mockResolvedValueOnce([]);

      const item = {
        id: "test-123",
        request: { marketId: "m1", oracleAddress: "G123" },
        result: {
          outcome: true,
          source: "Test",
          signature: "s1",
          publicKey: "p1",
          confidence: 0.8,
          confidenceMetadata: { score: 0.8, method: "test" },
          sourceMetadata: { provider: "Test" },
          timestamp: "2024-01-01T00:00:00Z",
        },
        status: "pending" as const,
        enqueuedAt: "2024-01-01T00:00:00Z",
        attempts: 1,
        streamId: "1-0",
        visibilityExpiresAt: Date.now() + 5000,
      };

      await queue.nack(item, "consumer-1");

      expect(mockClient.xclaim).toHaveBeenCalledWith(
        "test:oracle:submissions",
        "oracle-worker",
        "consumer-1",
        0,
        "1-0"
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Nacked oracle submission for retry",
        expect.any(Object)
      );
    });
  });

  describe("stream length cap (maxStreamLength)", () => {
    function makeItem(marketId = "mkt-cap"): SubmissionQueueItem {
      return {
        id: `item-${marketId}`,
        request: { marketId, oracleAddress: "GORACLE" },
        result: {
          outcome: true,
          source: "Test",
          signature: "sig",
          publicKey: "pub",
          confidence: 1,
          confidenceMetadata: { score: 1, method: "test" },
          sourceMetadata: { provider: "Test" },
          timestamp: "2024-01-01T00:00:00Z",
        },
        status: "pending" as const,
        enqueuedAt: "2024-01-01T00:00:00Z",
        attempts: 0,
      };
    }

    it("passes MAXLEN ~ args to xadd when maxStreamLength is set", async () => {
      const cappedClient = createMockRedisClient();
      cappedClient.exists.mockResolvedValue(0);
      cappedClient.set.mockResolvedValue("OK");
      cappedClient.xadd.mockResolvedValue("1-0");

      const cappedQueue = new RedisSubmissionQueue({
        redisClient: cappedClient,
        visibilityTimeoutMs: 5000,
        logger: mockLogger,
        keyPrefix: "test:",
        maxStreamLength: 500,
      });

      await cappedQueue.enqueue(makeItem("mkt-1"));

      expect(cappedClient.xadd).toHaveBeenCalledWith(
        "test:oracle:submissions",
        "MAXLEN",
        "~",
        "500",
        "*",
        "payload",
        expect.any(String),
        "marketId",
        "mkt-1",
        "payloadHash",
        expect.any(String)
      );
    });

    it("does not pass MAXLEN when maxStreamLength is 0 (default)", async () => {
      mockClient.exists.mockResolvedValue(0);
      mockClient.set.mockResolvedValue("OK");
      mockClient.xadd.mockResolvedValue("1-0");

      await queue.enqueue(makeItem("mkt-2"));

      const xaddArgs: string[] = mockClient.xadd.mock.calls[0];
      expect(xaddArgs).not.toContain("MAXLEN");
    });

    it("does not pass MAXLEN when maxStreamLength is omitted", async () => {
      const noCapClient = createMockRedisClient();
      noCapClient.exists.mockResolvedValue(0);
      noCapClient.set.mockResolvedValue("OK");
      noCapClient.xadd.mockResolvedValue("2-0");

      const noCapQueue = new RedisSubmissionQueue({
        redisClient: noCapClient,
        visibilityTimeoutMs: 5000,
        logger: mockLogger,
        keyPrefix: "test:",
        // maxStreamLength omitted
      });

      await noCapQueue.enqueue(makeItem("mkt-3"));

      const xaddArgs: string[] = noCapClient.xadd.mock.calls[0];
      expect(xaddArgs).not.toContain("MAXLEN");
    });
  });

  describe("getStreamLength", () => {
    it("returns the stream length reported by xlen", async () => {
      mockClient.xlen = vi.fn().mockResolvedValue(42);

      const len = await queue.getStreamLength();

      expect(len).toBe(42);
      expect(mockClient.xlen).toHaveBeenCalledWith("test:oracle:submissions");
    });

    it("returns 0 when xlen returns a non-number", async () => {
      mockClient.xlen = vi.fn().mockResolvedValue(null);

      const len = await queue.getStreamLength();

      expect(len).toBe(0);
    });
  });
});
