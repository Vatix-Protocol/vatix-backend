/**
 * Submission Worker Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../oracle/signature-helper.js", () => ({
  verifyResolutionReport: vi.fn((report: { signature?: string }) =>
    Boolean(report.signature)
  ),
}));

// Mocks for the Stellar SDK calls made by SubmissionWorker.broadcastAndConfirm().
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

// Vitest 4.x requires the `class` keyword (not an arrow function) inside
// mockImplementation for a mock to work as a constructor via `new`.
vi.mock("@stellar/stellar-sdk", () => ({
  Keypair: {
    fromSecret: vi.fn(() => ({
      publicKey: () => "GORACLEPUBLICKEY",
      sign: stellarMocks.sign,
    })),
  },
  Contract: vi.fn().mockImplementation(
    class {
      call = stellarMocks.contractCall;
    }
  ),
  TransactionBuilder: vi.fn().mockImplementation(
    class {
      addOperation = vi.fn().mockReturnThis();
      setTimeout = vi.fn().mockReturnThis();
      build = vi.fn(() => ({ sign: vi.fn() }));
    }
  ),
  nativeToScVal: vi.fn((value: unknown) => value),
  rpc: {
    Server: vi.fn().mockImplementation(
      class {
        getAccount = stellarMocks.getAccount;
        prepareTransaction = stellarMocks.prepareTransaction;
        sendTransaction = stellarMocks.sendTransaction;
        getTransaction = stellarMocks.getTransaction;
      }
    ),
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

vi.mock("../consumers/dead-letter.js", () => ({
  logDeadLetter: vi.fn(),
}));

import { SubmissionWorker } from "./submission-worker.js";
import type { QueuedSubmission } from "./redis-submission-queue.js";
import { logDeadLetter } from "../consumers/dead-letter.js";

const TEST_STELLAR_CONFIG = {
  rpcUrl: "https://rpc.test",
  contractId: "CCONTRACTTEST",
  networkPassphrase: "Test SDF Network ; September 2015",
  signerSecret: "SBTESTSECRETKEY",
};

/** In-memory stand-in for the oracle_reports row this worker upserts/updates,
 *  keyed by marketId — enough for these tests since each uses one market. */
function makeReportStore() {
  const rows = new Map<string, Record<string, unknown>>();

  return {
    rows,
    upsert: vi.fn(async (args: any) => {
      const key = args.where.marketId_payloadHash.marketId;
      const existing = rows.get(key);
      if (existing) return existing;
      const created = {
        id: `report-${key}`,
        status: "PENDING",
        txHash: null,
        attempts: 0,
        broadcastAt: null,
        confirmedAt: null,
        ...args.create,
      };
      rows.set(key, created);
      return created;
    }),
    update: vi.fn(async (args: any) => {
      const key = args.where.marketId_payloadHash.marketId;
      const existing = rows.get(key) ?? {
        status: "PENDING",
        txHash: null,
        attempts: 0,
        broadcastAt: null,
        confirmedAt: null,
      };
      const updated = { ...existing, ...args.data };
      rows.set(key, updated);
      return updated;
    }),
  };
}

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
    timestamp: "2026-01-01T00:00:00.000Z",
  },
  status: "pending",
  enqueuedAt: new Date().toISOString(),
  attempts: 0,
  streamId: "1-0",
  visibilityExpiresAt: Date.now() + 5000,
});

describe("SubmissionWorker", () => {
  let worker: SubmissionWorker;
  let mockPrisma: ReturnType<typeof buildMockPrisma>;
  let mockQueue: {
    acknowledge: ReturnType<typeof vi.fn>;
    nack: ReturnType<typeof vi.fn>;
  };

  function buildMockPrisma() {
    return {
      oracleReport: makeReportStore(),
      resolutionCandidate: {
        upsert: vi.fn(),
        updateMany: vi.fn(),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = buildMockPrisma();
    mockQueue = {
      acknowledge: vi.fn().mockResolvedValue(undefined),
      nack: vi.fn().mockResolvedValue(undefined),
    };
    worker = new SubmissionWorker(mockQueue as any, mockPrisma as any, {
      submissionMaxRetries: 3,
      consumerName: "test-consumer",
      logger: mockLogger,
    });
  });

  describe("processSubmission", () => {
    it("should process successful submission", async () => {
      const submission = createTestSubmission();
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });

      await worker.processSubmission(submission);

      expect(mockPrisma.oracleReport.upsert).toHaveBeenCalled();
      expect(mockPrisma.resolutionCandidate.upsert).toHaveBeenCalled();
      expect(mockQueue.acknowledge).toHaveBeenCalledWith(submission);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Oracle submission processed successfully",
        expect.any(Object)
      );
    });

    it("persists CONFIRMED status with null tx hash off-chain", async () => {
      const submission = createTestSubmission();
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });

      await worker.processSubmission(submission);

      const row = mockPrisma.oracleReport.rows.get("market-1");
      expect(row).toMatchObject({ status: "CONFIRMED", txHash: null });
    });

    it("does not re-claim a new row on retry — same (marketId, payloadHash) reuses one row", async () => {
      const submission = createTestSubmission();
      mockPrisma.resolutionCandidate.upsert.mockResolvedValue({
        id: "candidate-1",
      });

      await worker.processSubmission(submission);
      await worker.processSubmission(submission);

      // Only one row was ever created for this (marketId, payloadHash).
      expect(mockPrisma.oracleReport.rows.size).toBe(1);
      // Second call short-circuits on the already-CONFIRMED row.
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Oracle submission already confirmed, skipping resubmission",
        expect.any(Object)
      );
    });

    it("persists attempt count when retrying after a signature failure", async () => {
      const submission = createTestSubmission();

      await expect(
        worker.processSubmission({
          ...submission,
          result: { ...submission.result, signature: "" },
        })
      ).rejects.toThrow();

      const row = mockPrisma.oracleReport.rows.get("market-1");
      expect(row).toMatchObject({ attempts: submission.attempts + 1 });
      expect(mockQueue.nack).toHaveBeenCalled();
    });

    it("persists FAILED status when max attempts are exceeded", async () => {
      const submission = createTestSubmission();
      submission.attempts = 2;
      const invalidSubmission = {
        ...submission,
        result: { ...submission.result, signature: "" },
      };

      await expect(
        worker.processSubmission(invalidSubmission)
      ).rejects.toThrow();

      const row = mockPrisma.oracleReport.rows.get("market-1");
      expect(row).toMatchObject({ status: "FAILED", attempts: 3 });
      expect(mockQueue.acknowledge).toHaveBeenCalledWith(invalidSubmission);
    });

    it("should retry on first failure", async () => {
      const submission = createTestSubmission();

      await expect(
        worker.processSubmission({
          ...submission,
          result: { ...submission.result, signature: "" }, // Invalid signature
        })
      ).rejects.toThrow();

      expect(mockQueue.nack).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Oracle submission processing failed, will retry",
        expect.any(Object)
      );
    });

    it("should dead-letter after max retries", async () => {
      const submission = createTestSubmission();
      submission.attempts = 2; // Will exceed maxRetries of 3 on next attempt

      await expect(
        worker.processSubmission({
          ...submission,
          result: { ...submission.result, signature: "" },
        })
      ).rejects.toThrow();

      expect(mockQueue.acknowledge).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Oracle submission processing failed, max attempts exceeded",
        expect.any(Object)
      );
    });

    it("should call logDeadLetter with structured fields when max retries exceeded", async () => {
      const submission = createTestSubmission();
      submission.attempts = 2;
      mockPrisma.resolutionCandidate.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        worker.processSubmission({
          ...submission,
          result: { ...submission.result, signature: "" }, // triggers signature failure
        })
      ).rejects.toThrow();

      expect(logDeadLetter).toHaveBeenCalledOnce();
      expect(logDeadLetter).toHaveBeenCalledWith(
        mockLogger,
        expect.objectContaining({
          id: submission.id,
          queue: "oracle-submission",
          payload: expect.objectContaining({
            marketId: submission.request.marketId,
            oracleAddress: submission.request.oracleAddress,
          }),
          reason: expect.any(String),
        })
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
    });
  });

  describe("submitOnChain (Stellar SDK invocation)", () => {
    it("does not touch the Stellar SDK when no stellar config is provided", async () => {
      const submission = createTestSubmission();
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });

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
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });

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

      const row = mockPrisma.oracleReport.rows.get("market-1");
      expect(row).toMatchObject({ status: "CONFIRMED", txHash: "txhash123" });
    });

    it("Issue 4: does not confirm on a SUCCESS status missing ledger metadata — keeps polling until a genuine confirmation arrives", async () => {
      vi.useFakeTimers();
      const submission = createTestSubmission();
      stellarMocks.getAccount.mockResolvedValueOnce({
        accountId: () => "GSOURCEACCOUNT",
      });
      stellarMocks.prepareTransaction.mockResolvedValueOnce({
        sign: vi.fn(),
      });
      stellarMocks.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: "txhash-nolegder",
      });
      // First poll: status says SUCCESS but has no ledger — must not be
      // trusted as confirmation on the hash/status flag alone.
      stellarMocks.getTransaction.mockResolvedValueOnce({
        status: "SUCCESS",
      });
      // Second poll: a genuine confirmation with ledger metadata.
      stellarMocks.getTransaction.mockResolvedValueOnce({
        status: "SUCCESS",
        ledger: 55,
      });
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });

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

      const runPromise = stellarWorker.processSubmission(submission);
      await vi.runAllTimersAsync();
      await runPromise;

      expect(stellarMocks.getTransaction).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("without ledger metadata"),
        expect.objectContaining({ hash: "txhash-nolegder" })
      );
      const row = mockPrisma.oracleReport.rows.get("market-1");
      expect(row).toMatchObject({
        status: "CONFIRMED",
        txHash: "txhash-nolegder",
      });
      vi.useRealTimers();
    });

    it("persists the tx hash immediately on broadcast, before confirmation is known (#996)", async () => {
      vi.useFakeTimers();
      try {
        const submission = createTestSubmission();
        stellarMocks.getAccount.mockResolvedValueOnce({
          accountId: () => "GSOURCEACCOUNT",
        });
        stellarMocks.prepareTransaction.mockResolvedValueOnce({
          sign: vi.fn(),
        });
        stellarMocks.sendTransaction.mockResolvedValueOnce({
          status: "PENDING",
          hash: "txhash-broadcast",
        });
        // Never resolves confirmation within this test — we only care that
        // the hash lands in storage the moment sendTransaction returns.
        stellarMocks.getTransaction.mockResolvedValue({ status: "NOT_FOUND" });

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

        const processPromise = stellarWorker.processSubmission(submission);

        // Nothing in the chain up to recordBroadcast uses a timer (it's all
        // awaited promises), so flushing microtasks is enough to reach it —
        // well before the confirmation poll loop's first 1s sleep.
        await vi.advanceTimersByTimeAsync(0);

        const row = mockPrisma.oracleReport.rows.get("market-1");
        expect(row).toMatchObject({
          status: "SUBMITTED",
          txHash: "txhash-broadcast",
        });

        // Attach the rejection expectation before draining timers so the
        // rejection is never observed as "unhandled" mid-drain.
        const expectation =
          expect(processPromise).rejects.toThrow(/ambiguous/i);
        // Drain the 30 * 1s poll loop so the ambiguous-timeout error fires.
        await vi.advanceTimersByTimeAsync(30_000);
        await expectation;
      } finally {
        vi.useRealTimers();
      }
    });

    it("on redelivery, checks the chain instead of resubmitting when a broadcast is already unconfirmed", async () => {
      const submission = createTestSubmission();
      mockPrisma.oracleReport.rows.set("market-1", {
        id: "report-market-1",
        status: "SUBMITTED",
        txHash: "txhash-prior",
        attempts: 1,
        broadcastAt: new Date(),
        confirmedAt: null,
      });
      stellarMocks.getTransaction.mockResolvedValueOnce({
        status: "SUCCESS",
        ledger: 99,
      });
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });

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

      await stellarWorker.processSubmission({ ...submission, attempts: 1 });

      // No new transaction was ever broadcast — only the prior hash was
      // re-checked against the chain.
      expect(stellarMocks.sendTransaction).not.toHaveBeenCalled();
      expect(stellarMocks.getTransaction).toHaveBeenCalledWith("txhash-prior");
      expect(mockQueue.acknowledge).toHaveBeenCalledWith({
        ...submission,
        attempts: 1,
      });

      const row = mockPrisma.oracleReport.rows.get("market-1");
      expect(row).toMatchObject({
        status: "CONFIRMED",
        txHash: "txhash-prior",
      });
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

      await expect(stellarWorker.processSubmission(submission)).rejects.toThrow(
        /resolve_market submission failed/
      );

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

      await expect(stellarWorker.processSubmission(submission)).rejects.toThrow(
        /resolve_market transaction failed on-chain/
      );

      expect(mockQueue.nack).toHaveBeenCalled();

      // Definite on-chain failure clears the row for a fresh broadcast.
      const row = mockPrisma.oracleReport.rows.get("market-1");
      expect(row).toMatchObject({ status: "PENDING", txHash: null });
    });
  });

  describe("Issue 4: production must not silently fall back to off-chain confirmation", () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it("throws at construction time in production when no Stellar config is provided", () => {
      process.env.NODE_ENV = "production";

      expect(
        () =>
          new SubmissionWorker(mockQueue as any, mockPrisma as any, {
            submissionMaxRetries: 3,
            consumerName: "test-consumer",
            logger: mockLogger,
            // stellar intentionally omitted
          })
      ).toThrow(/refusing to fall back to off-chain-only confirmation/);
    });

    it("still allows the off-chain stub path outside production (local/dev)", () => {
      process.env.NODE_ENV = "development";

      expect(
        () =>
          new SubmissionWorker(mockQueue as any, mockPrisma as any, {
            submissionMaxRetries: 3,
            consumerName: "test-consumer",
            logger: mockLogger,
          })
      ).not.toThrow();
    });
  });

  describe("Stellar network passphrase validation", () => {
    it("rejects construction when the configured passphrase does not match the deployment network", () => {
      expect(
        () =>
          new SubmissionWorker(mockQueue as any, mockPrisma as any, {
            submissionMaxRetries: 3,
            consumerName: "test-consumer",
            logger: mockLogger,
            stellar: TEST_STELLAR_CONFIG, // testnet passphrase
            stellarNetwork: "mainnet",
          })
      ).toThrow(/does not match STELLAR_NETWORK="mainnet"/);
    });

    it("submits on-chain in test doubles when the passphrase matches the deployment network", async () => {
      const submission = createTestSubmission();
      stellarMocks.getAccount.mockResolvedValueOnce({
        accountId: () => "GSOURCEACCOUNT",
      });
      stellarMocks.prepareTransaction.mockResolvedValueOnce({
        sign: vi.fn(),
      });
      stellarMocks.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: "txhash-correct-network",
      });
      stellarMocks.getTransaction.mockResolvedValueOnce({
        status: "SUCCESS",
        ledger: 7,
      });
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });

      const stellarWorker = new SubmissionWorker(
        mockQueue as any,
        mockPrisma as any,
        {
          submissionMaxRetries: 3,
          consumerName: "test-consumer",
          logger: mockLogger,
          stellar: TEST_STELLAR_CONFIG,
          stellarNetwork: "testnet",
        }
      );

      await stellarWorker.processSubmission(submission);

      expect(stellarMocks.sendTransaction).toHaveBeenCalled();
      expect(mockQueue.acknowledge).toHaveBeenCalledWith(submission);
    });
  });

  describe("Stellar RPC retry/backoff", () => {
    let stellarWorker: SubmissionWorker;

    beforeEach(() => {
      vi.useFakeTimers();
      stellarWorker = new SubmissionWorker(
        mockQueue as any,
        mockPrisma as any,
        {
          submissionMaxRetries: 3,
          consumerName: "test-consumer",
          logger: mockLogger,
          stellar: TEST_STELLAR_CONFIG,
        }
      );
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries a transient getAccount failure in place and still succeeds", async () => {
      const submission = createTestSubmission();
      stellarMocks.getAccount
        .mockRejectedValueOnce(new Error("ECONNRESET: connection reset"))
        .mockResolvedValueOnce({ accountId: () => "GSOURCEACCOUNT" });
      stellarMocks.prepareTransaction.mockResolvedValueOnce({ sign: vi.fn() });
      stellarMocks.sendTransaction.mockResolvedValueOnce({
        status: "PENDING",
        hash: "txhash-retry",
      });
      stellarMocks.getTransaction.mockResolvedValueOnce({
        status: "SUCCESS",
        ledger: 1,
      });
      mockPrisma.resolutionCandidate.upsert.mockResolvedValueOnce({
        id: "candidate-1",
      });

      const processPromise = stellarWorker.processSubmission(submission);
      await vi.runAllTimersAsync();
      await processPromise;

      expect(stellarMocks.getAccount).toHaveBeenCalledTimes(2);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Retrying Stellar RPC call for resolve_market",
        expect.objectContaining({
          marketId: submission.request.marketId,
          attempt: 1,
        })
      );
    });

    it("does not retry a non-retryable (4xx-classified) failure", async () => {
      const submission = createTestSubmission();
      stellarMocks.getAccount.mockRejectedValue(
        new Error("400 Bad Request: invalid account")
      );

      const processPromise = stellarWorker.processSubmission(submission);
      const expectation =
        expect(processPromise).rejects.toThrow("400 Bad Request");
      await vi.runAllTimersAsync();
      await expectation;

      expect(stellarMocks.getAccount).toHaveBeenCalledTimes(1);
    });

    it("gives up and rejects after exhausting retries on a persistent transient failure", async () => {
      const submission = createTestSubmission();
      stellarMocks.getAccount.mockRejectedValue(
        new Error("ECONNRESET: connection reset")
      );

      const processPromise = stellarWorker.processSubmission(submission);
      const expectation = expect(processPromise).rejects.toThrow("ECONNRESET");
      await vi.runAllTimersAsync();
      await expectation;

      // maxRetries: 3 => 1 initial attempt + 3 retries = 4 calls total.
      expect(stellarMocks.getAccount).toHaveBeenCalledTimes(4);
    });
  });
});
