import "dotenv/config";
import { loadFinalizationConfig } from "./config.js";
import { FinalizationJob } from "./job.js";
import { createLogger } from "../../../indexer/src/logger.js";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../../../src/services/prisma.js";
import { createShutdown } from "../../../../packages/shared/src/shutdown.js";

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

  let isPollInProgress = false;

  const poll = async (): Promise<void> => {
    if (isPollInProgress) {
      logger.warn(
        "Skipping finalization poll because a previous poll is active",
        {
          intervalMs: config.intervalMs,
          component: "finalization-worker",
        }
      );
      return;
    }

    isPollInProgress = true;

    try {
      const result = await job.run();
      logger.info("Finalization worker poll complete", {
        component: "finalization-worker",
        totalCandidates: result.totalCandidates,
        finalizedCount: result.finalizedCount,
        erroredCount: result.erroredCount,
        skippedCount: result.skippedCount,
      });
    } catch (error) {
      logger.error("Finalization worker poll failed", {
        component: "finalization-worker",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      isPollInProgress = false;
    }
  };

  await poll();
  const timer = setInterval(() => void poll(), config.intervalMs);

  const shutdown = createShutdown(logger, {
    timeoutMs: 30_000,
    component: "finalization-worker",
    teardown: [
      async () => {
        clearInterval(timer);
      },
      async () => {
        await disconnectPrisma();
      },
    ],
  });

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
