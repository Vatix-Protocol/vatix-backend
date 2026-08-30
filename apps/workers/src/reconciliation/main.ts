import { Logger } from "../../../../packages/shared/src/logger.js";
import { loadReconciliationConfig } from "./config.js";
import { ReconciliationJob } from "./job.js";

const logger = new Logger("reconciliation-worker");

async function main() {
  try {
    const config = loadReconciliationConfig();

    logger.info("Reconciliation worker starting", {
      intervalMs: config.intervalMs,
      maxRunMs: config.maxRunMs,
      autoRecoveryEnabled: config.autoRecoveryEnabled,
    });

    const job = new ReconciliationJob(
      logger,
      config.maxRunMs,
      config.autoRecoveryEnabled
    );

    let inFlight: Promise<void> | null = null;

    const poll = async () => {
      // Skip if previous run still in flight
      if (inFlight) {
        logger.debug("Previous reconciliation still running, skipping");
        return;
      }

      inFlight = job
        .run()
        .then((result) => {
          logger.info("Reconciliation cycle completed", { ...result });
        })
        .catch((error) => {
          logger.error("Reconciliation cycle failed", { error });
        })
        .finally(() => {
          inFlight = null;
        });
    };

    const interval = setInterval(poll, config.intervalMs);

    const gracefulShutdown = async () => {
      logger.info("Shutting down reconciliation worker gracefully");
      clearInterval(interval);

      if (inFlight) {
        logger.info("Draining in-flight reconciliation job");
        try {
          await inFlight;
        } catch (error) {
          logger.error("Error draining in-flight job", { error });
        }
      }

      process.exit(0);
    };

    process.on("SIGTERM", gracefulShutdown);
    process.on("SIGINT", gracefulShutdown);

    // Run immediately
    await poll();
  } catch (error) {
    logger.error("Reconciliation worker startup failed", { error });
    process.exit(1);
  }
}

main();
