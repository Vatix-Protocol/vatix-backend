#!/usr/bin/env tsx
/**
 * Replay Dead-Letter Queue Admin CLI — issue #1136.
 *
 * Reads entries from Redis dead-letter streams and re-enqueues them to their
 * original queues. After a successful replay the dead-letter entry is removed.
 *
 * Usage:
 *   pnpm replay:dlq                                   # replay all DLQs
 *   pnpm replay:dlq -- --queue settlement              # one queue only
 *   pnpm replay:dlq -- --queue settlement --limit 10   # limit entries
 *   pnpm replay:dlq -- --dry-run                       # preview only
 *   pnpm replay:dlq -- --yes                           # confirm mutation
 *
 * In NODE_ENV=production a mutating replay refuses to run without `--yes`
 * (exit code 2); `--dry-run` previews and never needs it. The replay logic
 * lives in apps/workers/src/consumers/stream-dlq-replay.ts so it is unit
 * tested without a Redis server.
 *
 * Separate from `pnpm dlq` (scripts/dlq.ts, issue #953), which operates on the
 * BullMQ `failed` set for retry-exhausted jobs.
 *
 * @module scripts/replay-dlq
 */

import { randomUUID } from "crypto";
import Redis from "ioredis";
import {
  DlqUsageError,
  assertSafeQueueFilter,
  replayDeadLetters,
} from "../apps/workers/src/consumers/stream-dlq-replay.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? "vatix:";
const DLQ_PREFIX = `${KEY_PREFIX}dead-letter:`;

const correlationId = randomUUID();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Args {
  queueFilter?: string;
  limit?: number;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): Args {
  let queueFilter: string | undefined;
  let limit: number | undefined;
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--queue") {
      const value = argv[++i];
      if (value === undefined) {
        throw new DlqUsageError("--queue requires a value");
      }
      queueFilter = value;
    } else if (arg === "--limit") {
      const n = parseInt(argv[++i] ?? "", 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new DlqUsageError("--limit must be a positive integer");
      }
      limit = n;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else {
      throw new DlqUsageError(`Unknown argument: ${arg}`);
    }
  }

  assertSafeQueueFilter(queueFilter);
  return { queueFilter, limit, dryRun, yes };
}

function log(
  level: "info" | "warn" | "error",
  message: string,
  meta: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "replay-dlq",
      correlationId,
      message,
      ...meta,
    })
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nodeEnv = process.env.NODE_ENV ?? "development";

  // Production confirmation gate for the state-mutating path (dry-run exempt).
  if (!args.dryRun && nodeEnv === "production" && !args.yes) {
    log(
      "error",
      "Refusing to replay dead letters in production without --yes",
      {
        queueFilter: args.queueFilter ?? "*",
      }
    );
    process.exit(2);
  }

  log("info", "DLQ replay started", {
    queueFilter: args.queueFilter ?? "*",
    limit: args.limit ?? null,
    dryRun: args.dryRun,
    nodeEnv,
  });

  const redis = new Redis(REDIS_URL, {
    maxRetries: 3,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });

  try {
    const summary = await replayDeadLetters(redis, {
      dlqPrefix: DLQ_PREFIX,
      keyPrefix: KEY_PREFIX,
      queueFilter: args.queueFilter,
      limit: args.limit,
      dryRun: args.dryRun,
    });

    if (summary.streams.length === 0) {
      log("info", "No dead-letter streams found", { prefix: DLQ_PREFIX });
      return;
    }

    // Payloads are never logged by the mutating path; only ids and counts, so
    // settlement payloads never reach operator logs.
    if (summary.dryRun) {
      log("info", "[DRY-RUN] Replay preview complete", {
        streams: summary.streams,
        wouldReplay: summary.replayed,
        skipped: summary.skipped,
      });
    } else {
      log("info", "DLQ replay completed", {
        streams: summary.streams.length,
        scanned: summary.scanned,
        replayed: summary.replayed,
        skipped: summary.skipped,
      });
    }

    if (summary.failures.length > 0) {
      log("error", "DLQ replay had per-entry failures", {
        failed: summary.failures.length,
        failures: summary.failures,
      });
      process.exitCode = 1;
    }
  } finally {
    await redis.quit();
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

void main().catch((error) => {
  if (error instanceof DlqUsageError) {
    log("error", "Usage error", { detail: error.message });
    process.exit(2);
  }
  log("error", "DLQ replay script failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
