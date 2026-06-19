import "dotenv/config";
import { redis } from "../../../../src/services/redis.js";
import { createLogger } from "../../../indexer/src/logger.js";
import { disconnectPrisma } from "../../../../src/services/prisma.js";
import { SettlementWorker } from "./settlement-worker.js";
import type { QueueJob } from "../consumers/queue-consumer.js";

const STREAM_KEY = (): string => {
  const queueName = process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades";
  const keyPrefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
  return `${keyPrefix}${queueName}`;
};

const CONSUMER_GROUP = "settlement-worker";
const POLL_INTERVAL_MS = 5_000;
const MAX_ATTEMPTS = 3;
const PROCESSING_TIMEOUT_MS = 30_000;
const IDEMPOTENCY_TTL_SECONDS = 86_400;

function parseStreamFields(fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (let i = 0; i < fields.length - 1; i += 2) {
    result[fields[i]] = fields[i + 1];
  }
  return result;
}

async function initConsumerGroup(
  streamKey: string,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  try {
    await redis.xgroup("CREATE", streamKey, CONSUMER_GROUP, "$", {
      MKSTREAM: true,
    });
    logger.info("Settlement consumer group initialized", {
      stream: streamKey,
      group: CONSUMER_GROUP,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("BUSYGROUP")) {
      logger.info("Settlement consumer group already exists", {
        stream: streamKey,
        group: CONSUMER_GROUP,
      });
    } else {
      throw error;
    }
  }
}

async function pollMessages(
  streamKey: string,
  consumerName: string,
  worker: SettlementWorker,
  attemptTracker: Map<string, number>,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  let messages: Array<[string, Array<[string, string[]]>]> | null = null;

  try {
    messages = await redis.xreadgroup(
      CONSUMER_GROUP,
      consumerName,
      streamKey,
      ">",
      { COUNT: 10, BLOCK: 1000 }
    );
  } catch (error) {
    logger.error("Settlement consumer read error", {
      event: "settlement.consumer_error",
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!messages || messages.length === 0) {
    return;
  }

  const [, msgList] = messages[0];

  for (const [streamId, rawFields] of msgList) {
    const attempts = (attemptTracker.get(streamId) ?? 0) + 1;
    attemptTracker.set(streamId, attempts);

    const payload = parseStreamFields(rawFields);
    const job: QueueJob = {
      id: streamId,
      payload,
      attempts,
    };

    try {
      await worker.process(job);
      await redis.xack(streamKey, CONSUMER_GROUP, streamId);
      attemptTracker.delete(streamId);
    } catch {
      // Leave unacknowledged so Redis redelivers it on next poll
      logger.warn("Settlement job will be retried", {
        streamId,
        attempts,
        maxAttempts: MAX_ATTEMPTS,
      });
    }
  }
}

async function bootstrap(): Promise<void> {
  const logLevel = process.env.LOG_LEVEL ?? "info";
  const logger = createLogger(logLevel);
  const streamKey = STREAM_KEY();
  const consumerName = `settlement-consumer-${process.pid}`;
  const attemptTracker = new Map<string, number>();

  logger.info("Settlement worker started", {
    stream: streamKey,
    group: CONSUMER_GROUP,
  });

  await initConsumerGroup(streamKey, logger);

  const worker = new SettlementWorker(redis, logger, {
    maxAttempts: MAX_ATTEMPTS,
    processingTimeoutMs: PROCESSING_TIMEOUT_MS,
    idempotencyTtlSeconds: IDEMPOTENCY_TTL_SECONDS,
  });

  await pollMessages(streamKey, consumerName, worker, attemptTracker, logger);

  const timer = setInterval(
    () =>
      void pollMessages(
        streamKey,
        consumerName,
        worker,
        attemptTracker,
        logger
      ),
    POLL_INTERVAL_MS
  );

  const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  let isShuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
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
        component: "settlement-worker",
        validSignals: [...VALID_SHUTDOWN_SIGNALS],
      });
      return;
    }

    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info("Settlement worker shutdown initiated", {
      signal,
      component: "settlement-worker",
      status: "initiated",
    });

    clearInterval(timer);

    try {
      await disconnectPrisma();
      await redis.disconnect();
      logger.info("Settlement worker shutdown complete", {
        signal,
        component: "settlement-worker",
        status: "complete",
        exitCode: 0,
      });
      process.exit(0);
    } catch (error) {
      logger.error("Settlement worker shutdown failed", {
        signal,
        component: "settlement-worker",
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
      message: "Settlement worker failed during bootstrap",
      error: error instanceof Error ? error.message : String(error),
    })
  );
  process.exit(1);
});
