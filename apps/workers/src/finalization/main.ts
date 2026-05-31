import "dotenv/config";
import { loadFinalizationConfig } from "./config.js";
import { FinalizationJob } from "./job.js";
import { createLogger } from "../../../indexer/src/logger.js";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../../../src/services/prisma.js";

async function bootstrap(): Promise<void> {
  const config = loadFinalizationConfig();
  const logger = createLogger(config.logLevel);
  const prisma = getPrismaClient();
  const job = new FinalizationJob(prisma, logger, {
    challengeWindowSeconds: config.challengeWindowSeconds,
  });

  logger.info("Finalization worker started", {
    intervalMs: config.intervalMs,
    challengeWindowSeconds: config.challengeWindowSeconds,
  });

  await job.run();
  const timer = setInterval(() => void job.run(), config.intervalMs);

  const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (
      typeof signal !== "string" ||
      signal.trim() === "" ||
      !VALID_SHUTDOWN_SIGNALS.includes(
        signal as (typeof VALID_SHUTDOWN_SIGNALS)[number],
      )
    ) {
      logger.warn("Graceful shutdown called with invalid signal", {
        signal,
        statusCode: 400,
        component: "finalization-worker",
        validSignals: [...VALID_SHUTDOWN_SIGNALS],
      });
      return;
    }

    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Graceful shutdown initiated", {
      signal,
      component: "finalization-worker",
    });
    clearInterval(timer);

    try {
      await disconnectPrisma();
      logger.info("Worker shutdown complete", {
        signal,
        component: "finalization-worker",
      });
      process.exit(0);
    } catch (error) {
      logger.error("Worker shutdown failed", {
        signal,
        component: "finalization-worker",
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
      message: "Finalization worker failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
