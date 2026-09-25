import "dotenv/config";
import { loadAuditArchiverConfig } from "./config.js";
import { AuditArchiverJob } from "./job.js";
import { createLogger } from "../../../indexer/src/logger.js";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../../../src/services/prisma.js";
import { createShutdown } from "../../../../packages/shared/src/shutdown.js";

async function bootstrap(): Promise<void> {
  const config = loadAuditArchiverConfig();
  const logger = createLogger(config.logLevel);
  const prisma = getPrismaClient();
  const job = new AuditArchiverJob(prisma, logger, {
    maxRunMs: config.maxRunMs,
    batchSize: config.batchSize,
  });

  logger.info("Audit archiver worker started", {
    intervalMs: config.intervalMs,
    maxRunMs: config.maxRunMs,
    batchSize: config.batchSize,
  });

  let activePollPromise: Promise<void> | null = null;

  const poll = async (): Promise<void> => {
    if (activePollPromise) {
      logger.warn(
        "Skipping audit archiver poll because a previous poll is active",
        {
          intervalMs: config.intervalMs,
          component: "audit-archiver-worker",
        }
      );
      return;
    }

    const pollPromise = (async () => {
      try {
        const result = await job.run();
        logger.info("Audit archiver worker poll complete", {
          component: "audit-archiver-worker",
          totalEvents: result.totalEvents,
          archivedCount: result.archivedCount,
          erroredCount: result.erroredCount,
          skippedCount: result.skippedCount,
          archiveLagMs: result.archiveLagMs,
        });
      } catch (error) {
        logger.error("Audit archiver worker poll failed", {
          component: "audit-archiver-worker",
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
    component: "audit-archiver-worker",
    teardown: [
      async () => {
        clearInterval(timer);
      },
      async () => {
        if (activePollPromise) {
          logger.info(
            "Waiting for active audit archiver poll to complete before shutdown",
            { component: "audit-archiver-worker" }
          );
          await activePollPromise.catch((err: unknown) => {
            logger.warn(
              "In-flight audit archiver poll failed during graceful shutdown",
              {
                component: "audit-archiver-worker",
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
      message: "Audit archiver worker failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
