/**
 * BullMQ Settlement Consumer — ADR 001 (#452)
 *
 * Replaces the ad-hoc Redis Streams bootstrap in consumer.ts with a BullMQ
 * Worker that provides unified retry/backoff/DLQ via DEFAULT_JOB_OPTIONS.
 *
 * The SettlementWorker.process() handler is unchanged — BullMQ job data is
 * mapped to the existing QueueJob shape so all unit tests continue to pass.
 *
 * @module apps/workers/src/settlement/bullmq-consumer
 */
import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { redis } from "../../../../src/services/redis.js";
import { createLogger } from "../../../indexer/src/logger.js";
import { disconnectPrisma } from "../../../../src/services/prisma.js";
import { SettlementWorker } from "./settlement-worker.js";
import type { QueueJob } from "../consumers/queue-consumer.js";
import { redisConnectionFromEnv } from "../shared/queue-config.js";

const QUEUE_NAME = (): string => {
  const name = process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades";
  const prefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
  return `${prefix}${name}`;
};

const MAX_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_MS = 30_000;
const IDEMPOTENCY_TTL_SECONDS = 86_400;

async function bootstrap(): Promise<void> {
  const logLevel = process.env.LOG_LEVEL ?? "info";
  const logger = createLogger(logLevel);
  const queueName = QUEUE_NAME();

  logger.info("BullMQ settlement worker started", { queue: queueName });

  const settlementWorker = new SettlementWorker(redis, logger, {
    maxAttempts: MAX_ATTEMPTS,
    processingTimeoutMs: PROCESSING_TIMEOUT_MS,
    idempotencyTtlSeconds: IDEMPOTENCY_TTL_SECONDS,
  });

  const worker = new Worker<Record<string, unknown>>(
    queueName,
    async (job: Job<Record<string, unknown>>) => {
      // Map BullMQ Job → QueueJob shape used by SettlementWorker
      const queueJob: QueueJob = {
        id: job.id ?? job.name,
        payload: job.data,
        attempts: job.attemptsMade + 1,
      };
      await settlementWorker.process(queueJob);
    },
    {
      connection: redisConnectionFromEnv(),
      // BullMQ handles retry/backoff per DEFAULT_JOB_OPTIONS set at enqueue time.
      // concurrency defaults to 1 — safe for idempotency checks.
      concurrency: 1,
    }
  );

  worker.on("completed", (job) => {
    logger.info("Settlement job completed", { jobId: job.id });
  });

  worker.on("failed", (job, err) => {
    logger.error("Settlement job failed", {
      jobId: job?.id,
      attempts: job?.attemptsMade,
      error: err.message,
    });
  });

  const VALID_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let isShuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("BullMQ settlement worker shutting down", { signal });

    try {
      await worker.close();
      await disconnectPrisma();
      await redis.disconnect();
      logger.info("BullMQ settlement worker stopped", { signal });
      process.exit(0);
    } catch (error) {
      logger.error("Shutdown error", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  for (const sig of VALID_SIGNALS) {
    process.on(sig, () => void shutdown(sig));
  }
}

void bootstrap().catch((error) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      message: "BullMQ settlement worker failed to start",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
