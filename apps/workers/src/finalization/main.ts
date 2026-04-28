import "dotenv/config";
import { loadFinalizationConfig } from "./config.js";
import { FinalizationJob } from "./job.js";
import { createLogger } from "../../../indexer/src/logger.js";
import { getPrismaClient, disconnectPrisma } from "../../../../src/services/prisma.js";

async function bootstrap(): Promise<void> {
  const config = loadFinalizationConfig();
  const logger = createLogger(config.logLevel);
  const prisma = getPrismaClient();
  const job = new FinalizationJob(prisma, logger, config.challengeWindowSeconds);

  logger.info("Finalization worker started", {
    intervalMs: config.intervalMs,
    challengeWindowSeconds: config.challengeWindowSeconds,
  });

  await job.run();
  const timer = setInterval(() => void job.run(), config.intervalMs);

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Finalization worker shutting down", { signal });
    clearInterval(timer);

    try {
      await disconnectPrisma();
      logger.info("Finalization worker shutdown complete");
      process.exit(0);
    } catch (error) {
      logger.error("Finalization worker shutdown failed", {
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
