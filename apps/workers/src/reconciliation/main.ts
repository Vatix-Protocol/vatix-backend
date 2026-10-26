import { createLogger } from "../../../../packages/shared/src/logger.js";
import { createShutdown } from "@vatix/shared/shutdown.js";
import { loadConfig } from "./config.js";
import { ReconciliationJob } from "./job.js";
import { startHealthServer } from "../health-server.js";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../../../src/services/prisma.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info("Starting reconciliation worker", {
    intervalMs: config.intervalMs,
    maxRunMs: config.maxRunMs,
    autoRecoveryEnabled: config.autoRecoveryEnabled,
  });

  const job = new ReconciliationJob(
    logger,
    config.maxRunMs,
    config.autoRecoveryEnabled
  );

  const healthServer = startHealthServer({
    component: "reconciliation-worker",
    getPrismaClient,
  });

  let inFlight: Promise<void> | null = null;
  let interval: NodeJS.Timeout | null = null;

  const poll = (): void => {
    if (inFlight) {
      logger.warn("Skipping reconciliation run: previous run still in flight");
      return;
    }

    inFlight = (async () => {
      try {
        const result = await job.run();
        logger.info("Reconciliation run completed", {
          totalMarkets: result.totalMarkets,
          completedMarkets: result.completedMarkets,
          failedMarkets: result.failedMarkets,
          driftCount: result.aggregateStats.driftCount,
          recoveredCount: result.aggregateStats.recoveredCount,
          dryRun: result.dryRun,
        });
      } catch (error) {
        logger.error("Reconciliation run failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        inFlight = null;
      }
    })();
  };

  interval = setInterval(poll, config.intervalMs);
  poll();

  const shutdown = createShutdown(logger, {
    timeoutMs: 30_000,
    component: "reconciliation-worker",
    teardown: [
      async () => {
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
      },
      async () => {
        if (inFlight) {
          await inFlight;
        }
      },
      async () => {
        await healthServer.close();
      },
      async () => {
        await disconnectPrisma();
      },
    ],
  });

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting reconciliation worker", error);
  process.exit(1);
});
