import "dotenv/config";
import { loadExpiryConfig } from "./config.js";
import { ExpiryJob } from "./job.js";
import { createLogger } from "../../../indexer/src/logger.js";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../../../src/services/prisma.js";
import { createShutdown } from "../../../../packages/shared/src/shutdown.js";

async function bootstrap(): Promise<void> {
  const config = loadExpiryConfig();
  const logger = createLogger(config.logLevel);
  const prisma = getPrismaClient();
  const job = new ExpiryJob(prisma, logger, {
    maxRunMs: config.maxRunMs,
    clockSkewToleranceMs: config.clockSkewToleranceMs,
  });

  logger.info("Expiry worker started", {
    intervalMs: config.intervalMs,
    maxRunMs: config.maxRunMs,
    clockSkewToleranceMs: config.clockSkewToleranceMs,
  });

  let activePollPromise: Promise<void> | null = null;

  const poll = async (): Promise<void> => {
    if (activePollPromise) {
      logger.warn("Skipping expiry poll because a previous poll is active", {
        intervalMs: config.intervalMs,
        component: "expiry-worker",
      });
      return;
    }

    const pollPromise = (async () => {
      try {
        const result = await job.run();
        logger.info("Expiry worker poll complete", {
          component: "expiry-worker",
          totalCandidates: result.totalCandidates,
          expiredCount: result.expiredCount,
          erroredCount: result.erroredCount,
          skippedCount: result.skippedCount,
        });
      } catch (error) {
        logger.error("Expiry worker poll failed", {
          component: "expiry-worker",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    activePollPromise = pollPromise;
    await pollPromise;
    activePollPromise = null;
  };

  await poll();
  const timer = setInterval(() => void poll(), config.intervalMs);

  const shutdown = createShutdown(logger, {
    timeoutMs: 30_000,
    component: "expiry-worker",
    teardown: [
      async () => {
        clearInterval(timer);
      },
      async () => {
        if (activePollPromise) {
          logger.info(
            "Waiting for active expiry poll to complete before shutdown",
            { component: "expiry-worker" }
          );
          await activePollPromise.catch((err: unknown) => {
            logger.warn(
              "In-flight expiry poll failed during graceful shutdown",
              {
                component: "expiry-worker",
                error: err instanceof Error ? err.message : String(err),
              }
            );
          });
        }
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
      message: "Expiry worker failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
