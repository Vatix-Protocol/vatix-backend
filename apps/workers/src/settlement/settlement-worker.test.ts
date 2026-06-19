import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SettlementWorker,
  type SettlementWorkerConfig,
  type SettlementRedisClient,
} from "./settlement-worker.js";
import type { QueueJob } from "../consumers/queue-consumer.js";
import type { ILogger } from "../../../../packages/shared/src/logger.js";

function makeLogger(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function makeRedisClient(
  overrides?: Partial<SettlementRedisClient>
): SettlementRedisClient {
  return {
    exists: vi.fn().mockResolvedValue(false),
    set: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeConfig(
  overrides?: Partial<SettlementWorkerConfig>
): SettlementWorkerConfig {
  return {
    maxAttempts: 3,
    processingTimeoutMs: 5_000,
    idempotencyTtlSeconds: 86_400,
    ...overrides,
  };
}

function makeJob(overrides?: Partial<QueueJob>): QueueJob {
  return {
    id: "stream-id-1-0",
    payload: {
      tradeId: "trade-abc-123",
      marketId: "market-001",
      outcome: "YES",
      buyOrderId: "buy-order-1",
      sellOrderId: "sell-order-1",
      buyerAddress: "GBUYERADDRESS",
      sellerAddress: "GSELLERADDRESS",
      price: "0.65",
      quantity: "100",
      timestamp: "1700000000000",
    },
    attempts: 1,
    ...overrides,
  };
}

describe("SettlementWorker", () => {
  let logger: ILogger;
  let redisClient: SettlementRedisClient;
  let worker: SettlementWorker;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = makeLogger();
    redisClient = makeRedisClient();
    worker = new SettlementWorker(redisClient, logger, makeConfig());
  });

  describe("process — success path", () => {
    it("logs job receipt and completion for a new trade", async () => {
      const job = makeJob();

      await worker.process(job);

      expect(logger.info).toHaveBeenCalledWith(
        "Job received from queue",
        expect.objectContaining({
          jobId: job.id,
          queue: "settlement",
          attempt: 1,
        })
      );
      expect(logger.info).toHaveBeenCalledWith(
        "Processing settlement job",
        expect.objectContaining({ tradeId: "trade-abc-123" })
      );
      expect(logger.info).toHaveBeenCalledWith(
        "Settlement job completed",
        expect.objectContaining({ tradeId: "trade-abc-123" })
      );
      expect(logger.info).toHaveBeenCalledWith(
        "Job processed successfully",
        expect.objectContaining({ jobId: job.id })
      );
    });

    it("writes the idempotency key to Redis on success", async () => {
      const job = makeJob();

      await worker.process(job);

      expect(redisClient.set).toHaveBeenCalledWith(
        "settlement:processed:trade-abc-123",
        "1",
        86_400
      );
    });
  });

  describe("process — idempotency", () => {
    it("skips processing when trade was already processed", async () => {
      redisClient = makeRedisClient({
        exists: vi.fn().mockResolvedValue(true),
      });
      worker = new SettlementWorker(redisClient, logger, makeConfig());

      const job = makeJob();

      await worker.process(job);

      expect(logger.info).toHaveBeenCalledWith(
        "Settlement job skipped (already processed)",
        expect.objectContaining({ tradeId: "trade-abc-123", jobId: job.id })
      );
      expect(redisClient.set).not.toHaveBeenCalled();
    });

    it("checks the correct idempotency key", async () => {
      const job = makeJob({
        payload: { ...makeJob().payload, tradeId: "trade-xyz-999" },
      });

      await worker.process(job);

      expect(redisClient.exists).toHaveBeenCalledWith(
        "settlement:processed:trade-xyz-999"
      );
    });
  });

  describe("process — failure path", () => {
    it("re-throws the error when handler fails below max attempts", async () => {
      redisClient = makeRedisClient({
        exists: vi.fn().mockRejectedValue(new Error("Redis down")),
      });
      worker = new SettlementWorker(
        redisClient,
        logger,
        makeConfig({ maxAttempts: 3 })
      );

      const job = makeJob({ attempts: 1 });

      await expect(worker.process(job)).rejects.toThrow("Redis down");
    });

    it("logs warn (not error) when attempts remain", async () => {
      redisClient = makeRedisClient({
        exists: vi.fn().mockRejectedValue(new Error("transient")),
      });
      worker = new SettlementWorker(
        redisClient,
        logger,
        makeConfig({ maxAttempts: 3 })
      );

      const job = makeJob({ attempts: 1 });

      await expect(worker.process(job)).rejects.toThrow();

      expect(logger.warn).toHaveBeenCalledWith(
        "Job processing failed, will retry",
        expect.objectContaining({ jobId: job.id, attempt: 1 })
      );
      expect(logger.error).not.toHaveBeenCalled();
    });

    it("dead-letters and logs error after max attempts", async () => {
      redisClient = makeRedisClient({
        exists: vi.fn().mockRejectedValue(new Error("permanent failure")),
      });
      worker = new SettlementWorker(
        redisClient,
        logger,
        makeConfig({ maxAttempts: 3 })
      );

      const job = makeJob({ attempts: 3 });

      await expect(worker.process(job)).rejects.toThrow("permanent failure");

      expect(logger.error).toHaveBeenCalledWith(
        "Job processing failed, max attempts exceeded",
        expect.objectContaining({ jobId: job.id, attempt: 3, maxAttempts: 3 })
      );
      expect(logger.error).toHaveBeenCalledWith(
        "Job dead-lettered",
        expect.objectContaining({
          messageId: job.id,
          queue: "settlement",
          reason: "permanent failure",
        })
      );
    });

    it("does not dead-letter when attempts are below max", async () => {
      redisClient = makeRedisClient({
        exists: vi.fn().mockRejectedValue(new Error("transient")),
      });
      worker = new SettlementWorker(
        redisClient,
        logger,
        makeConfig({ maxAttempts: 3 })
      );

      const job = makeJob({ attempts: 2 });

      await expect(worker.process(job)).rejects.toThrow();

      const deadLetterCalls = (
        logger.error as ReturnType<typeof vi.fn>
      ).mock.calls.filter((call) => call[0] === "Job dead-lettered");
      expect(deadLetterCalls).toHaveLength(0);
    });
  });
});
