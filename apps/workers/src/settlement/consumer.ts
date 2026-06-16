import "dotenv/config";
import { redis } from "../../../src/services/redis.js";
import { createLogger } from "../../../indexer/src/logger.js";
import {
  getPrismaClient,
  disconnectPrisma,
} from "../../../src/services/prisma.js";
import type { ILogger } from "../../../packages/shared/src/logger.js";

const STREAM_KEY = () => {
  const queueName = process.env.SETTLEMENT_QUEUE_NAME ?? "settlement-trades";
  const keyPrefix = process.env.REDIS_KEY_PREFIX ?? "vatix:";
  return `${keyPrefix}${queueName}`;
};

const CONSUMER_GROUP = "settlement-worker";

interface SettlementJob {
  tradeId: string;
  marketId: string;
  outcome: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerAddress: string;
  sellerAddress: string;
  price: string;
  quantity: string;
  timestamp: string;
}

class SettlementConsumer {
  private logger: ILogger;

  constructor(logger: ILogger) {
    this.logger = logger;
  }

  async initialize(): Promise<void> {
    try {
      await redis.xgroup("CREATE", STREAM_KEY(), CONSUMER_GROUP, "$", {
        MKSTREAM: true,
      });
      this.logger.info("Settlement consumer group initialized", {
        stream: STREAM_KEY(),
        group: CONSUMER_GROUP,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("BUSYGROUP")) {
        this.logger.info("Settlement consumer group already exists", {
          stream: STREAM_KEY(),
          group: CONSUMER_GROUP,
        });
      } else {
        throw error;
      }
    }
  }

  async processJob(job: SettlementJob, streamId: string): Promise<void> {
    this.logger.info(
      {
        event: "settlement.received",
        tradeId: job.tradeId,
        marketId: job.marketId,
        buyOrderId: job.buyOrderId,
        sellOrderId: job.sellOrderId,
        price: job.price,
        quantity: job.quantity,
      },
      "Settlement job received"
    );

    // TODO: Implement actual settlement execution on-chain
    // For now, this is a stub that logs the job
  }

  async run(): Promise<void> {
    const streamKey = STREAM_KEY();

    try {
      const client = redis["getClient"]?.();
      if (!client) {
        this.logger.error("Redis client not available");
        return;
      }

      // Read pending messages (any messages not yet acknowledged)
      const pending = await (client.xreadgroup as any)(
        "GROUP",
        CONSUMER_GROUP,
        `settlement-consumer-${Date.now()}`,
        "BLOCK",
        "1000",
        "STREAMS",
        streamKey,
        ">"
      );

      if (!pending || pending.length === 0) {
        return;
      }

      const [, messages] = pending[0];

      for (const [streamId, fields] of messages) {
        try {
          const jobData = Object.fromEntries(
            fields.reduce((acc: any[], val: any, i: number) => {
              if (i % 2 === 0) acc.push([val]);
              else acc[acc.length - 1].push(val);
              return acc;
            }, [])
          ) as SettlementJob;

          await this.processJob(jobData, streamId);

          // Acknowledge the message
          await (client.xack as any)(streamKey, CONSUMER_GROUP, streamId);
        } catch (error) {
          this.logger.error(
            {
              event: "settlement.processing_failed",
              streamId,
              error: error instanceof Error ? error.message : String(error),
            },
            "Settlement job processing failed"
          );
        }
      }
    } catch (error) {
      this.logger.error(
        {
          event: "settlement.consumer_error",
          error: error instanceof Error ? error.message : String(error),
        },
        "Settlement consumer error"
      );
    }
  }
}

async function bootstrap(): Promise<void> {
  const logLevel = process.env.LOG_LEVEL ?? "info";
  const logger = createLogger(logLevel);
  const prisma = getPrismaClient();
  const consumer = new SettlementConsumer(logger);

  logger.info("Settlement worker started", {
    stream: STREAM_KEY(),
    group: CONSUMER_GROUP,
  });

  await consumer.initialize();
  await consumer.run();

  const timer = setInterval(() => void consumer.run(), 5000);

  const VALID_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
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
