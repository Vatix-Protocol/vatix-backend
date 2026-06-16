/**
 * Submission Worker Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SubmissionWorker } from "./submission-worker.js";
import type { QueuedSubmission } from "./redis-submission-queue.js";

// Mock Prisma
const mockPrisma = {
  oracleReport: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  resolutionCandidate: {
    upsert: vi.fn(),
  },
};

// Mock queue
const mockQueue = {
  acknowledge: vi.fn(),
  nack: vi.fn(),
};

// Mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const createTestSubmission = (): QueuedSubmission => ({
  id: "test-123",
  request: {
    marketId: "market-1",
    oracleAddress: "GTEST123456789",
  },
  result: {
    outcome: true,
    source: "Chainlink",
    signature: "dGVzdF9zaWduYXR1cmU=", // base64 encoded
    publicKey: "GTEST123456789",
  },
  status: "pending",
  enqueuedAt: new Date().toISOString(),
  attempts: 0,
  streamId: "1-0",
  visibilityExpiresAt: Date.now() + 5000,
});

describe("SubmissionWorker", () => {
  let worker: SubmissionWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new SubmissionWorker(mockQueue as any, mockPrisma as any, {
      submissionMaxRetries: 3,
      consumerName: "test-consumer",
      logger: mockLogger,
    });
  });

  describe("processSubmission", () => {
    it("should process successful submission", async () => {
      const submission = createTestSubmission();
      mockPrisma.oracleReport.upsert.mockResolvedValueOnce({
        id: "report-1",
      });
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });
      mockQueue.acknowledge.mockResolvedValueOnce(undefined);

      await worker.processSubmission(submission);

      expect(mockPrisma.oracleReport.upsert).toHaveBeenCalled();
      expect(mockPrisma.resolutionCandidate.upsert).toHaveBeenCalled();
      expect(mockQueue.acknowledge).toHaveBeenCalledWith(submission);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Oracle submission processed successfully",
        expect.any(Object)
      );
    });

    it("should retry on first failure", async () => {
      const submission = createTestSubmission();
      const error = new Error("Network error");

      // Mock successful DB writes but then throw on submission
      mockPrisma.oracleReport.updateMany.mockResolvedValueOnce({
        count: 1,
      });
      mockQueue.nack.mockResolvedValueOnce(undefined);

      // Create an override for processSubmission to simulate network error
      // We'll do this by checking the error flow directly
      await expect(
        worker.processSubmission({
          ...submission,
          result: { ...submission.result, signature: "" }, // Invalid signature
        })
      ).rejects.toThrow();

      // Should have nacked for retry
      expect(mockQueue.nack).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Oracle submission processing failed, will retry",
        expect.any(Object)
      );
    });

    it("should dead-letter after max retries", async () => {
      const submission = createTestSubmission();
      submission.attempts = 2; // Will exceed maxRetries of 3 on next attempt

      mockPrisma.oracleReport.updateMany.mockResolvedValueOnce({
        count: 1,
      });
      mockQueue.acknowledge.mockResolvedValueOnce(undefined);

      await expect(
        worker.processSubmission({
          ...submission,
          result: { ...submission.result, signature: "" },
        })
      ).rejects.toThrow();

      // Should acknowledge (remove from active queue)
      expect(mockQueue.acknowledge).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Oracle submission processing failed, max attempts exceeded",
        expect.any(Object)
      );
    });

    it("should handle Prisma errors gracefully", async () => {
      const submission = createTestSubmission();
      mockPrisma.oracleReport.upsert.mockRejectedValueOnce(
        new Error("DB error")
      );

      await expect(worker.processSubmission(submission)).rejects.toThrow(
        "DB error"
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to persist oracle submission",
        expect.any(Object)
      );
    });
  });
});
