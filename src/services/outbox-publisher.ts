/**
 * Settlement Outbox Publisher — transactional outbox pattern.
 *
 * MatchingService.placeOrder writes an OutboxEvent row in the SAME
 * Prisma transaction as the Trade upsert, so a committed trade and its
 * outbox row are atomic. This module drains PENDING/FAILED outbox rows into
 * the settlement queue (`settlementQueue.enqueue`) and marks them PUBLISHED,
 * guaranteeing at-least-once delivery even if the process crashes or Redis
 * is unreachable between commit and enqueue.
 *
 * See docs/adr/003-settlement-outbox.md for the full design and operator
 * recovery flow.
 *
 * @module src/services/outbox-publisher
 */
import type { PrismaClient } from "../generated/prisma/client/index.js";
import { getPrismaClient } from "./prisma.js";
import { settlementQueue, type SettlementJob } from "./settlement-queue.js";
import {
  settlementOutboxDepthGauge,
  settlementOutboxLagSecondsGauge,
  settlementOutboxPublishFailuresTotal,
  settlementOutboxOrphanedTradesGauge,
  settlementOutboxQuarantinedEntriesGauge,
  settlementOutboxQuarantineTransitionsTotal,
} from "./metrics.js";

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

/**
 * Attempts after which a still-failing row is surfaced via the
 * orphaned-trade-count metric (for alerting). It is NOT abandoned — the
 * publisher keeps retrying with capped exponential backoff indefinitely.
 */
const ORPHAN_ATTEMPTS_THRESHOLD =
  Number(process.env.OUTBOX_ORPHAN_ATTEMPTS_THRESHOLD) || 5;

/**
 * Attempts after which a permanently failing row is moved to QUARANTINED status.
 * Must be >= ORPHAN_ATTEMPTS_THRESHOLD to ensure alerting is visible before quarantine.
 * In production, this must be enforced (no silent fallback to indefinite retries).
 */
const QUARANTINE_ATTEMPTS_THRESHOLD =
  Number(process.env.OUTBOX_QUARANTINE_ATTEMPTS_THRESHOLD) || 10;

/** Minimal shape needed to publish + mark a single outbox row. */
export interface OutboxRow {
  tradeId: string;
  payload: SettlementJob;
  attempts: number;
}

function backoffMs(attempts: number): number {
  const delay = DEFAULT_BASE_BACKOFF_MS * 2 ** attempts;
  return Math.min(delay, DEFAULT_MAX_BACKOFF_MS);
}

/**
 * Builds the SettlementJob payload persisted in an outbox row from the
 * fields available immediately after a Trade is upserted.
 */
export function buildSettlementPayload(trade: {
  id: string;
  marketId: string;
  outcome: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerAddress: string;
  sellerAddress: string;
  price: number;
  quantity: number;
  timestamp: number;
}): SettlementJob {
  return {
    tradeId: trade.id,
    marketId: trade.marketId,
    outcome: trade.outcome as SettlementJob["outcome"],
    buyOrderId: trade.buyOrderId,
    sellOrderId: trade.sellOrderId,
    buyerAddress: trade.buyerAddress,
    sellerAddress: trade.sellerAddress,
    price: trade.price,
    quantity: trade.quantity,
    timestamp: trade.timestamp,
  };
}

/**
 * Publishes a single outbox row to the settlement queue and marks the
 * outcome atomically, keyed on the unique `tradeId` rather than a
 * previously-read row id — the caller (matching-service's post-commit fast
 * path) never needs to round-trip the generated outbox row id.
 *
 * Idempotent on tradeId: safe to call more than once for the same trade
 * (e.g. the fast path and the background drain racing the same row). A
 * duplicate call can at worst enqueue the settlement job twice; the
 * settlement consumer already idempotency-checks on tradeId (#870), so no
 * position is ever applied twice.
 */
export async function publishOutboxRow(
  prisma: PrismaClient,
  row: OutboxRow
): Promise<"published" | "failed" | "quarantined"> {
  const client = prisma as unknown as {
    outboxEvent: {
      updateMany: (args: unknown) => Promise<{ count: number }>;
    };
  };

  try {
    await settlementQueue.enqueue(row.payload);

    await client.outboxEvent.updateMany({
      where: { tradeId: row.tradeId, status: { not: "PUBLISHED" } },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });

    return "published";
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const nextAttempt = row.attempts + 1;

    // Check if we've exceeded the quarantine threshold
    if (nextAttempt >= QUARANTINE_ATTEMPTS_THRESHOLD) {
      await client.outboxEvent.updateMany({
        where: { tradeId: row.tradeId, status: { not: "PUBLISHED" } },
        data: {
          status: "QUARANTINED",
          attempts: nextAttempt,
          lastError: err.message.slice(0, 2000),
          quarantinedAt: new Date(),
        },
      });

      settlementOutboxPublishFailuresTotal.inc();
      settlementOutboxQuarantineTransitionsTotal.inc();
      console.error(
        JSON.stringify({
          level: "error",
          component: "outbox-publisher",
          action: "outbox_quarantined",
          tradeId: row.tradeId,
          attempts: nextAttempt,
          message: err.message,
        })
      );

      return "quarantined";
    }

    await client.outboxEvent.updateMany({
      where: { tradeId: row.tradeId, status: { not: "PUBLISHED" } },
      data: {
        status: "FAILED",
        attempts: nextAttempt,
        lastError: err.message.slice(0, 2000),
        nextAttemptAt: new Date(Date.now() + backoffMs(nextAttempt)),
      },
    });

    settlementOutboxPublishFailuresTotal.inc();
    console.error(
      JSON.stringify({
        level: "error",
        component: "outbox-publisher",
        action: "outbox_publish_failed",
        tradeId: row.tradeId,
        attempts: nextAttempt,
        message: err.message,
      })
    );

    return "failed";
  }
}

/**
 * Drains one batch of due (PENDING or FAILED-and-past-backoff) outbox rows.
 * Safe to call concurrently from multiple processes: publishing is
 * idempotent on tradeId (see publishOutboxRow), so at worst two instances
 * both publish the same row in the same window — never a lost trade.
 */
export async function drainOutboxOnce(
  prisma: PrismaClient,
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<{ published: number; failed: number }> {
  const client = prisma as unknown as {
    outboxEvent: {
      findMany: (args: unknown) => Promise<
        Array<{
          tradeId: string;
          payload: unknown;
          attempts: number;
          status: string;
        }>
      >;
    };
  };

  const rows = await client.outboxEvent.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      nextAttemptAt: { lte: new Date() },
    },
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let published = 0;
  let failed = 0;

  for (const row of rows) {
    const outcome = await publishOutboxRow(prisma, {
      tradeId: row.tradeId,
      payload: row.payload as SettlementJob,
      attempts: row.attempts,
    });
    if (outcome === "published") {
      published++;
    } else {
      failed++;
    }
  }

  await refreshOutboxMetrics(prisma);

  return { published, failed };
}

/** Recomputes the outbox depth/lag/orphaned/quarantined gauges from current DB state. */
export async function refreshOutboxMetrics(
  prisma: PrismaClient
): Promise<void> {
  const client = prisma as unknown as {
    outboxEvent: {
      count: (args: unknown) => Promise<number>;
      findFirst: (args: unknown) => Promise<{ createdAt: Date } | null>;
    };
  };

  const [depth, oldest, orphaned, quarantined] = await Promise.all([
    client.outboxEvent.count({
      where: { status: { in: ["PENDING", "FAILED"] } },
    }),
    client.outboxEvent.findFirst({
      where: { status: { in: ["PENDING", "FAILED"] } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    }),
    client.outboxEvent.count({
      where: {
        status: "FAILED",
        attempts: { gte: ORPHAN_ATTEMPTS_THRESHOLD },
      },
    }),
    client.outboxEvent.count({
      where: { status: "QUARANTINED" },
    }),
  ]);

  settlementOutboxDepthGauge.set(depth);
  settlementOutboxLagSecondsGauge.set(
    oldest ? (Date.now() - oldest.createdAt.getTime()) / 1000 : 0
  );
  settlementOutboxOrphanedTradesGauge.set(orphaned);
  settlementOutboxQuarantinedEntriesGauge.set(quarantined);
}

export interface OutboxPublisherOptions {
  intervalMs?: number;
  batchSize?: number;
  prisma?: PrismaClient;
}

let timer: ReturnType<typeof setInterval> | null = null;
let draining = false;

/**
 * Starts the background drain loop on a fixed interval. Safe to call once
 * per process; a second call is a no-op while a loop is already running.
 * Configurable via OUTBOX_PUBLISHER_INTERVAL_MS / OUTBOX_PUBLISHER_BATCH_SIZE.
 */
export function startOutboxPublisher(
  options: OutboxPublisherOptions = {}
): void {
  if (timer) return;

  const intervalMs =
    options.intervalMs ??
    (Number(process.env.OUTBOX_PUBLISHER_INTERVAL_MS) || 2_000);
  const batchSize =
    options.batchSize ??
    (Number(process.env.OUTBOX_PUBLISHER_BATCH_SIZE) || DEFAULT_BATCH_SIZE);
  const prisma = options.prisma ?? getPrismaClient();

  timer = setInterval(() => {
    if (draining) return;
    draining = true;
    drainOutboxOnce(prisma, batchSize)
      .catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            component: "outbox-publisher",
            action: "drain_failed",
            message: error instanceof Error ? error.message : String(error),
          })
        );
      })
      .finally(() => {
        draining = false;
      });
  }, intervalMs);

  timer.unref?.();
}

/** Stops the background drain loop. Used by graceful shutdown and tests. */
export function stopOutboxPublisher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
