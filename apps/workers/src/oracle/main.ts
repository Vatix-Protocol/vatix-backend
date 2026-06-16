/**
 * Oracle Submission Worker Entrypoint
 *
 * Bootstraps the oracle submission worker that consumes from the Redis queue
 * and submits signed resolutions on-chain.
 *
 * @module apps/workers/src/oracle/main
 */

import "dotenv/config";
import { createLogger } from "../../../indexer/src/logger.js";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../../../src/services/prisma.js";
import { redis } from "../../../../src/services/redis.js";
import { loadOracleWorkerConfig } from "../../../../packages/shared/src/config.js";
import { RedisSubmissionQueue } from "./redis-submission-queue.js";
import { SubmissionWorker } from "./submission-worker.js";
import type { ShutdownHandler, ShutdownSignal } from "../finalization/types.js";

async function bootstrap(): Promise<void> {
  const config = loadOracleWorkerConfig();
  const logger = createLogger(config.logLevel);
  const prisma = getPrismaClient();

  logger.info("Oracle submission worker starting", {
    pollIntervalMs: config.submissionPollIntervalMs,
    maxRetries: config.submissionMaxRetries,
    visibilityTimeoutMs: config.submissionVisibilityTimeoutMs,
  });

  const queue = new RedisSubmissionQueue({
    redisClient: redis,
    visibilityTimeoutMs: config.submissionVisibilityTimeoutMs,
    logger,
  });

  const worker = new SubmissionWorker(queue, prisma, {
    submissionMaxRetries: config.submissionMaxRetries,
    consumerName: `oracle-worker-${Date.now()}`,
    logger,
  });

  // Initialize the queue (idempotent)
  await queue.initialize();

  // Run immediately, then poll at configured interval
  async function runWorker(): Promise<void> {
    try {
      const submission = await queue.dequeue(
        worker["consumerName"],
        config.submissionPollIntervalMs
      );

      if (submission) {
        try {
          await worker.processSubmission(submission);
        } catch (error) {
          // Errors are logged by processSubmission
          // Continue polling for next item
        }
      }
    } catch (error) {
      logger.error("Unexpected error in worker loop", {
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Start continuous polling
  await runWorker();
  const timer = setInterval(
    () => void runWorker(),
    config.submissionPollIntervalMs
  );

  const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  let isShuttingDown = false;
  const shutdown: ShutdownHandler = async (signal: ShutdownSignal) => {
    if (
      typeof signal !== "string" ||
      signal.trim() === "" ||
      !VALID_SHUTDOWN_SIGNALS.includes(
        signal as (typeof VALID_SHUTDOWN_SIGNALS)[number]
      )
    ) {
      logger.warn("Graceful shutdown called with invalid signal", {
        signal,
        statusCode: 400,
        component: "oracle-worker",
        validSignals: [...VALID_SHUTDOWN_SIGNALS],
      });
      return;
    }

    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Oracle worker shutdown initiated", {
      signal,
      component: "oracle-worker",
      status: "initiated",
    });

    clearInterval(timer);

    try {
      await disconnectPrisma();
      await redis.disconnect();

      logger.info("Oracle worker shutdown complete", {
        signal,
        component: "oracle-worker",
        status: "complete",
        exitCode: 0,
      });
      process.exit(0);
    } catch (error) {
      logger.error("Oracle worker shutdown failed", {
        signal,
        component: "oracle-worker",
        status: "failed",
        exitCode: 1,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void bootstrap().catch((error) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      message: "Oracle worker failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
