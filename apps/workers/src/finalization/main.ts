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

  let activePollPromise: Promise<void> | null = null;

  const poll = async (): Promise<void> => {
    if (activePollPromise) {
      logger.warn(
        "Skipping finalization poll because a previous poll is active",
        {
          intervalMs: config.intervalMs,
          component: "finalization-worker",
        }
      );
      return;
    }

    const pollPromise = (async () => {
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
    component: "finalization-worker",
    teardown: [
      // Stop the scheduler first so no new polls are started.
      async () => {
        clearInterval(timer);
      },
      // Drain any in-flight poll before closing the DB connection.
      // This ensures an active finalization transaction is never silently
      // abandoned mid-flight on SIGTERM (acceptance: #777).
      async () => {
        if (activePollPromise) {
          logger.info(
            "Waiting for active finalization poll to complete before shutdown",
            { component: "finalization-worker" }
          );
          // Best-effort drain — the outer createShutdown timeout will force-
          // exit if this takes longer than the configured 30 s window.
          await activePollPromise.catch((err: unknown) => {
            logger.warn(
              "In-flight finalization poll failed during graceful shutdown",
              {
                component: "finalization-worker",
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
      message: "Finalization worker failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
