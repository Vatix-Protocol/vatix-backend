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
    });
    vi.clearAllMocks();
  });

  describe("initialize", () => {
    it("should create consumer group on first init", async () => {
      mockClient.xgroup.mockResolvedValueOnce(undefined);

      await queue.initialize();

      expect(mockClient.xgroup).toHaveBeenCalledWith(
        "CREATE",
        "oracle:submissions",
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

    it("should enqueue item and set dedup flag", async () => {
      mockClient.exists.mockResolvedValueOnce(0); // Not already queued
      mockClient.xadd.mockResolvedValueOnce("1-0"); // Stream ID
      mockClient.set.mockResolvedValueOnce("OK");

      const result = await queue.enqueue(testItem);

      expect(result).toBe(true);
      expect(mockClient.xadd).toHaveBeenCalledWith(
        "oracle:submissions",
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
    it("should acknowledge processed message", async () => {
      mockClient.xack.mockResolvedValueOnce(1);

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
        "oracle:submissions",
        "oracle-worker",
        "1-0"
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Acknowledged oracle submission",
        expect.any(Object)
      );
    });
  });

  describe("nack", () => {
    it("should nack message for retry", async () => {
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

      await queue.nack(item);

      expect(mockClient.xclaim).toHaveBeenCalledWith(
        "oracle:submissions",
        "oracle-worker",
        "nack-worker",
        0,
        "1-0"
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Nacked oracle submission for retry",
        expect.any(Object)
      );
    });
  });
});
