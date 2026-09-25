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
import {
  redisConnectionFromEnv,
  settlementQueueName,
} from "../../../packages/shared/src/queue-config.js";
import { settlementJobStalledTotal } from "../../../../src/services/metrics.js";

const MAX_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_MS = 30_000;
const IDEMPOTENCY_TTL_SECONDS = 86_400;

/**
 * Worker concurrency for settle_trade processing.
 *
 * This MUST stay at 1 in production. settle_trade is not safe to run
 * concurrently within a single worker process: SettlementWorker's
 * idempotency check-then-set against Redis is not atomic across two
 * in-process concurrent handlers pulled from the same BullMQ Worker, so a
 * concurrency > 1 here can double-apply settle_trade for two jobs that
 * both pass the idempotency check before either records its lock. Scale
 * throughput by running more worker *processes/replicas* (each with
 * concurrency 1), not by raising this value.
 */
export function resolveSettlementConcurrency(env: {
  NODE_ENV?: string;
  SETTLEMENT_WORKER_CONCURRENCY?: string;
}): number {
  const raw = env.SETTLEMENT_WORKER_CONCURRENCY;
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  const concurrency = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;

  if (env.NODE_ENV === "production" && concurrency !== 1) {
    // Fail fast: refuse to boot with an unsafe concurrency in production
    // instead of silently double-applying settle_trade under load.
    throw new Error(
      `SETTLEMENT_WORKER_CONCURRENCY=${concurrency} is not supported in production. ` +
        "settle_trade idempotency is only guaranteed at concurrency=1 per worker process; " +
        "scale via additional replicas instead."
    );
  }
  return concurrency;
}

const SETTLEMENT_WORKER_CONCURRENCY = resolveSettlementConcurrency(
  process.env as { NODE_ENV?: string; SETTLEMENT_WORKER_CONCURRENCY?: string }
);

/**
 * How long (ms) a job may run before BullMQ considers the worker that
 * claimed it dead and reclaims the job as stalled. Must comfortably exceed
 * PROCESSING_TIMEOUT_MS (the settlement worker's own per-job timeout) so a
 * slow-but-alive job isn't reclaimed out from under its owner and picked
 * up by a second replica while the first is still finishing — that
 * double-claim is exactly the "two workers settle_trade the same job"
 * failure mode this hardens against.
 */
const STALLED_LOCK_DURATION_MS = PROCESSING_TIMEOUT_MS * 2;

/** How often BullMQ checks for stalled jobs. */
const STALLED_CHECK_INTERVAL_MS = 30_000;

/**
 * A job is only ever allowed to be reclaimed as stalled once. If it stalls
 * a second time, BullMQ marks it failed instead of recycling it forever —
 * this bounds how many times a wedged job can be picked up by a *different*
 * worker before it's forced onto the normal retry/DLQ path where
 * SettlementWorker's idempotency check is authoritative.
 */
const MAX_STALLED_COUNT = 1;

async function bootstrap(): Promise<void> {
  const logLevel = process.env.LOG_LEVEL ?? "info";
  const logger = createLogger(logLevel as Parameters<typeof createLogger>[0]);
  const queueName = settlementQueueName();

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
      // concurrency MUST stay 1 — see SETTLEMENT_WORKER_CONCURRENCY above.
      concurrency: SETTLEMENT_WORKER_CONCURRENCY,
      lockDuration: STALLED_LOCK_DURATION_MS,
      stalledInterval: STALLED_CHECK_INTERVAL_MS,
      maxStalledCount: MAX_STALLED_COUNT,
    }
  );

  logger.info("Settlement worker concurrency/stall configuration", {
    concurrency: SETTLEMENT_WORKER_CONCURRENCY,
    lockDurationMs: STALLED_LOCK_DURATION_MS,
    stalledIntervalMs: STALLED_CHECK_INTERVAL_MS,
    maxStalledCount: MAX_STALLED_COUNT,
    nodeEnv: process.env.NODE_ENV ?? "development",
  });

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

  // A stalled job means BullMQ believes the worker that claimed it died
  // (missed its lock renewal). It will be redelivered — possibly to a
  // different replica — so this is the earliest signal of the exact
  // "settle_trade applied twice" risk this hardening targets. Surface it
  // as a metric rather than only a log line so it can be alerted on.
  worker.on("stalled", (jobId: string) => {
    settlementJobStalledTotal.inc();
    logger.warn("Settlement job stalled and will be reclaimed", { jobId });
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
