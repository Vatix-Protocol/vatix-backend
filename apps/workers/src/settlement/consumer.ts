/**
 * Settlement Worker Entrypoint — BullMQ (ADR 001)
 *
 * Replaces the raw Redis Streams polling loop with a BullMQ Worker that
 * provides unified retry/backoff/DLQ via DEFAULT_JOB_OPTIONS.
 *
 * The SettlementWorker.process() handler is unchanged — BullMQ job data is
 * mapped to the existing QueueJob shape so all unit tests continue to pass.
 *
 * @module apps/workers/src/settlement/consumer
 */
import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { redis } from "../../../../src/services/redis.js";
import { createLogger } from "../../../indexer/src/logger.js";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../../../src/services/prisma.js";
import {
  SettlementWorker,
  type SettlementStellarConfig,
  type SettlementPrismaClient,
} from "./settlement-worker.js";
import type { QueueJob } from "../consumers/queue-consumer.js";
import {
  redisConnectionFromEnv,
  settlementQueueName,
} from "../shared/queue-config.js";
import { createShutdown } from "../../../../packages/shared/src/shutdown.js";

const MAX_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_MS = 30_000;
const IDEMPOTENCY_TTL_SECONDS = 86_400;
/** Permanent failures for the same tradeId before it is quarantined (#870). */
const QUARANTINE_THRESHOLD = (() => {
  const parsed = Number(process.env.SETTLEMENT_QUARANTINE_THRESHOLD);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
})();

async function bootstrap(): Promise<void> {
  const logLevel = (process.env.LOG_LEVEL ?? "info") as Parameters<
    typeof createLogger
  >[0];
  const logger = createLogger(logLevel);
  const queueName = settlementQueueName();

  logger.info("Settlement worker started (BullMQ)", {
    queue: queueName,
  });

  const rpcUrl = process.env.STELLAR_RPC_URL;
  const contractId = process.env.SETTLEMENT_CONTRACT_ID;
  const networkPassphrase = process.env.SOROBAN_NETWORK_PASSPHRASE;
  const signerSecret = process.env.STELLAR_SECRET_KEY;

  const stellar: SettlementStellarConfig | undefined =
    rpcUrl && contractId && networkPassphrase && signerSecret
      ? { rpcUrl, contractId, networkPassphrase, signerSecret }
      : undefined;

  if (!stellar) {
    logger.warn(
      "Stellar config incomplete — on-chain settlement disabled. " +
        "Set STELLAR_RPC_URL, SETTLEMENT_CONTRACT_ID, SOROBAN_NETWORK_PASSPHRASE, " +
        "and STELLAR_SECRET_KEY to enable.",
      { component: "settlement-worker" }
    );
  }

  const settlementWorker = new SettlementWorker(
    redis,
    logger,
    {
      maxAttempts: MAX_ATTEMPTS,
      processingTimeoutMs: PROCESSING_TIMEOUT_MS,
      idempotencyTtlSeconds: IDEMPOTENCY_TTL_SECONDS,
      stellar,
      quarantineThreshold: QUARANTINE_THRESHOLD,
    },
    getPrismaClient() as unknown as SettlementPrismaClient
  );

  const worker = new Worker<Record<string, unknown>>(
    queueName,
    async (job: Job<Record<string, unknown>>) => {
      const queueJob: QueueJob = {
        id: job.id ?? job.name,
        payload: job.data,
        attempts: job.attemptsMade + 1,
      };
      await settlementWorker.process(queueJob);
    },
    {
      connection: redisConnectionFromEnv(),
      concurrency: 1,
    }
  );

  worker.on("completed", (job) => {
    logger.info("Settlement job completed", {
      jobId: job.id,
      component: "settlement-worker",
    });
  });

  worker.on("failed", (job, err) => {
    logger.error("Settlement job failed", {
      jobId: job?.id,
      attempts: job?.attemptsMade,
      error: err.message,
      component: "settlement-worker",
    });
  });

  // BullMQ forwards Redis connection errors as "error" events. Without a
  // listener, Node's default EventEmitter behavior is to throw and crash
  // the process on the next transient Redis blip.
  worker.on("error", (err) => {
    logger.error("Settlement worker connection error", {
      error: err.message,
      component: "settlement-worker",
    });
  });

  const shutdown = createShutdown(logger, {
    timeoutMs: 30_000,
    component: "settlement-worker",
    teardown: [
      async () => {
        await worker.close();
      },
      async () => {
        await disconnectPrisma();
      },
      async () => {
        await redis.disconnect();
      },
    ],
  });

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => void shutdown(sig));
  }
}

void bootstrap().catch((error) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      message: "Settlement worker failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
