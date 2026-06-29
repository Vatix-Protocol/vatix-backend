/**
 * Submission Worker Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../oracle/signature-helper.js", () => ({
  verifyResolutionReport: vi.fn((report: { signature?: string }) =>
    Boolean(report.signature)
  ),
}));

// Mocks for the Stellar SDK calls made by SubmissionWorker.submitOnChain().
// Exposed via vi.hoisted so individual tests can configure return values.
const stellarMocks = vi.hoisted(() => ({
  sign: vi.fn(),
  getAccount: vi.fn(),
  prepareTransaction: vi.fn(),
  sendTransaction: vi.fn(),
  getTransaction: vi.fn(),
  contractCall: vi.fn((method: string, ...args: unknown[]) => ({
    method,
    args,
  })),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    fromSecret: vi.fn(() => ({
      publicKey: () => "GORACLEPUBLICKEY",
      sign: stellarMocks.sign,
    })),
  },
  Contract: vi.fn().mockImplementation(() => ({
    call: stellarMocks.contractCall,
  })),
  TransactionBuilder: vi.fn().mockImplementation(() => {
    const builder = {
      addOperation: vi.fn(() => builder),
      setTimeout: vi.fn(() => builder),
      build: vi.fn(() => ({ sign: vi.fn() })),
    };
    return builder;
  }),
  nativeToScVal: vi.fn((value: unknown) => value),
  rpc: {
    Server: vi.fn().mockImplementation(() => ({
      getAccount: stellarMocks.getAccount,
      prepareTransaction: stellarMocks.prepareTransaction,
      sendTransaction: stellarMocks.sendTransaction,
      getTransaction: stellarMocks.getTransaction,
    })),
    Api: {
      GetTransactionStatus: {
        SUCCESS: "SUCCESS",
        FAILED: "FAILED",
        NOT_FOUND: "NOT_FOUND",
      },
    },
  },
  xdr: {},
}));

import { SubmissionWorker } from "./submission-worker.js";
import type { QueuedSubmission } from "./redis-submission-queue.js";

const TEST_STELLAR_CONFIG = {
  rpcUrl: "https://rpc.test",
  contractId: "CCONTRACTTEST",
  networkPassphrase: "Test SDF Network ; September 2015",
  signerSecret: "SBTESTSECRETKEY",
};

// Mock Prisma
const mockPrisma = {
  oracleReport: {
    create: vi.fn(),
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
  child: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }),
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
    confidence: 0.9,
    confidenceMetadata: { score: 0.9, method: "test" },
    sourceMetadata: { provider: "Chainlink" },
    timestamp: new Date().toISOString(),
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
      mockPrisma.oracleReport.create.mockResolvedValueOnce({
        id: "report-1",
      });
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });
      mockQueue.acknowledge.mockResolvedValueOnce(undefined);

      await worker.processSubmission(submission);

      expect(mockPrisma.oracleReport.create).toHaveBeenCalled();
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
      mockPrisma.oracleReport.create.mockRejectedValueOnce(
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

  describe("submitOnChain (Stellar SDK invocation)", () => {
    it("does not touch the Stellar SDK when no stellar config is provided", async () => {
      const submission = createTestSubmission();
      mockPrisma.oracleReport.create.mockResolvedValueOnce({ id: "report-1" });
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });
      mockQueue.acknowledge.mockResolvedValueOnce(undefined);

      await worker.processSubmission(submission);

      expect(stellarMocks.getAccount).not.toHaveBeenCalled();
      expect(stellarMocks.sendTransaction).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("resolve_market call skipped"),
        expect.any(Object)
      );
    });

    it("invokes resolve_market via the Stellar SDK when stellar config is provided", async () => {
      const submission = createTestSubmission();
      stellarMocks.getAccount.mockResolvedValueOnce({
        accountId: () => "GSOURCEACCOUNT",
      });
      stellarMocks.prepareTransaction.mockResolvedValueOnce({
        sign: vi.fn(),
      });
      stellarMocks.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: "txhash123",
      });
      stellarMocks.getTransaction.mockResolvedValueOnce({
        status: "SUCCESS",
        ledger: 42,
      });
      mockPrisma.oracleReport.create.mockResolvedValueOnce({ id: "report-1" });
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });
      mockQueue.acknowledge.mockResolvedValueOnce(undefined);

      const stellarWorker = new SubmissionWorker(
        mockQueue as any,
        mockPrisma as any,
        {
          submissionMaxRetries: 3,
          consumerName: "test-consumer",
          logger: mockLogger,
          stellar: TEST_STELLAR_CONFIG,
        }
      );

      await stellarWorker.processSubmission(submission);

      expect(stellarMocks.contractCall).toHaveBeenCalledWith(
        "resolve_market",
        submission.request.marketId,
        submission.result.outcome,
        expect.anything(),
        submission.result.publicKey
      );
      expect(stellarMocks.sendTransaction).toHaveBeenCalled();
      expect(stellarMocks.getTransaction).toHaveBeenCalledWith("txhash123");
      expect(mockQueue.acknowledge).toHaveBeenCalledWith(submission);
    });

    it("retries when sendTransaction reports an ERROR status", async () => {
      const submission = createTestSubmission();
      stellarMocks.getAccount.mockResolvedValueOnce({
        accountId: () => "GSOURCEACCOUNT",
      });
      stellarMocks.prepareTransaction.mockResolvedValueOnce({
        sign: vi.fn(),
      });
      stellarMocks.sendTransaction.mockResolvedValueOnce({
        status: "ERROR",
        hash: "txhash-err",
      });
      mockPrisma.oracleReport.updateMany.mockResolvedValueOnce({ count: 1 });
      mockQueue.nack.mockResolvedValueOnce(undefined);

      const stellarWorker = new SubmissionWorker(
        mockQueue as any,
        mockPrisma as any,
        {
          submissionMaxRetries: 3,
          consumerName: "test-consumer",
          logger: mockLogger,
          stellar: TEST_STELLAR_CONFIG,
        }
      );

      await expect(
        stellarWorker.processSubmission(submission)
      ).rejects.toThrow(/resolve_market submission failed/);

      expect(stellarMocks.getTransaction).not.toHaveBeenCalled();
      expect(mockQueue.nack).toHaveBeenCalled();
    });

    it("retries when the on-chain transaction ultimately fails", async () => {
      const submission = createTestSubmission();
      stellarMocks.getAccount.mockResolvedValueOnce({
        accountId: () => "GSOURCEACCOUNT",
      });
      stellarMocks.prepareTransaction.mockResolvedValueOnce({
        sign: vi.fn(),
      });
      stellarMocks.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: "txhash-failed",
      });
      stellarMocks.getTransaction.mockResolvedValueOnce({
        status: "FAILED",
      });
      mockPrisma.oracleReport.updateMany.mockResolvedValueOnce({ count: 1 });
      mockQueue.nack.mockResolvedValueOnce(undefined);

      const stellarWorker = new SubmissionWorker(
        mockQueue as any,
        mockPrisma as any,
        {
          submissionMaxRetries: 3,
          consumerName: "test-consumer",
          logger: mockLogger,
          stellar: TEST_STELLAR_CONFIG,
        }
      );

      await expect(
        stellarWorker.processSubmission(submission)
      ).rejects.toThrow(/resolve_market transaction failed on-chain/);

      expect(mockQueue.nack).toHaveBeenCalled();
    });
  });
});
