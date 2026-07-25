#!/usr/bin/env tsx
/**
 * Replay Dead-Letter Queue Admin CLI
 *
 * Reads entries from Redis dead-letter streams and re-enqueues them to their
 * original queues.  After a successful replay the dead-letter entry is removed.
 *
 * Usage:
 *   pnpm tsx scripts/replay-dlq.ts                                # replay all DLQs
 *   pnpm tsx scripts/replay-dlq.ts --queue settlement             # one queue only
 *   pnpm tsx scripts/replay-dlq.ts --queue settlement --limit 10  # limit entries
 *   pnpm tsx scripts/replay-dlq.ts --dry-run                      # preview only
 *
 * @module scripts/replay-dlq
 */

import Redis from "ioredis";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? "vatix:";
const DLQ_PREFIX = `${KEY_PREFIX}dead-letter:`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(): {
  queueFilter?: string;
  limit: number;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let queueFilter: string | undefined;
  let limit = Infinity;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--queue" && args[i + 1]) {
      queueFilter = args[++i];
    } else if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      if (!Number.isFinite(limit) || limit < 1) limit = Infinity;
      i++;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }

  return { queueFilter, limit, dryRun };
}

function log(level: string, message: string, meta?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "replay-dlq",
      message,
      ...meta,
    })
  );
}

// ---------------------------------------------------------------------------
// Discover & helpers
// ---------------------------------------------------------------------------

async function discoverDLQStreams(
  redis: Redis,
  queueFilter?: string
): Promise<string[]> {
  const pattern = queueFilter
    ? `${DLQ_PREFIX}${queueFilter}`
    : `${DLQ_PREFIX}*`;

  const keys: string[] = [];
  let cursor = "0";

  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return keys.sort();
}

function fieldsToRecord(fields: string[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key === "payload") {
      try {
        record[key] = JSON.parse(value);
      } catch {
        record[key] = value;
      }
    } else {
      record[key] = value;
    }
  }
  return record;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { queueFilter, limit, dryRun } = parseArgs();

  log("info", "DLQ replay started", { queueFilter: queueFilter ?? "*", dryRun });

  const redis = new Redis(REDIS_URL, {
    maxRetries: 3,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });

  let totalReplayed = 0;
  let totalFailed = 0;

  try {
    const streamKeys = await discoverDLQStreams(redis, queueFilter);

    if (streamKeys.length === 0) {
      log("info", "No dead-letter streams found", { prefix: DLQ_PREFIX });
      return;
    }

    log("info", "Discovered dead-letter streams", {
      streams: streamKeys,
      count: streamKeys.length,
    });

    for (const streamKey of streamKeys) {
      const queueName = streamKey.replace(DLQ_PREFIX, "");

      if (totalReplayed >= limit) {
        log("info", "Replay limit reached, stopping", { limit });
        break;
      }

      const entries: Array<[string, string[]]> = await redis.xrange(
        streamKey,
        "-",
        "+"
      );

      if (entries.length === 0) continue;

      log("info", `Processing DLQ stream "${streamKey}"`, {
        queue: queueName,
        entries: entries.length,
      });

      for (const [entryId, fields] of entries) {
        if (totalReplayed >= limit) break;

        const message = fieldsToRecord(fields);

        log("info", "Replaying dead-letter entry", {
          entryId,
          queue: queueName,
          originalMessageId: message.messageId,
          reason: message.reason,
        });

        if (dryRun) {
          log("info", "[DRY-RUN] Would replay entry", {
            entryId,
            queue: queueName,
            payload: message.payload,
          });
          totalReplayed++;
          continue;
        }

        try {
          const targetStream = `${KEY_PREFIX}${queueName}`;
          const rawPayload =
            typeof message.payload === "object" && message.payload !== null
              ? message.payload
              : {};

          const xaddFields: string[] = [];
          for (const [key, value] of Object.entries(rawPayload)) {
            xaddFields.push(key, String(value));
          }

          if (xaddFields.length > 0) {
            await redis.xadd(targetStream, "*", ...xaddFields);
          }

          await redis.xdel(streamKey, entryId);

          log("info", "Entry replayed and removed from DLQ", {
            entryId,
            queue: queueName,
            targetStream,
          });

          totalReplayed++;
        } catch (error) {
          totalFailed++;
          log("error", "Failed to replay entry", {
            entryId,
            queue: queueName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    log("info", "DLQ replay completed", {
      replayed: totalReplayed,
      failed: totalFailed,
      dryRun,
    });
  } finally {
    await redis.quit();
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

void main().catch((error) => {
  log("error", "DLQ replay script failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
