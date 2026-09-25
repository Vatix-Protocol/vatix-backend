#!/usr/bin/env tsx
/**
 * Replay Dead-Letter Queue Admin CLI
 *
 * Reads entries from Redis dead-letter streams (`{prefix}dead-letter:{queue}`)
 * and re-enqueues them to their original queues. After a successful replay the
 * dead-letter entry is removed.
 *
 * Usage:
 *   pnpm replay:dlq                                  # replay all DLQs
 *   pnpm replay:dlq --queue settlement               # one queue only
 *   pnpm replay:dlq --queue settlement --limit 10    # limit entries
 *   pnpm replay:dlq --dry-run                        # preview only
 *   pnpm replay:dlq --queue settlement --yes         # confirm a production run
 *
 * Safety (#1136):
 *   - In NODE_ENV=production a mutating run (anything without --dry-run)
 *     refuses to start without --yes and exits with code 2, mirroring the
 *     BullMQ DLQ CLI (`pnpm dlq`).
 *   - Every log line carries a per-invocation `correlationId` for stitching
 *     an operator session back to its audit trail.
 *   - Payloads are never logged — only `payloadType` + `payloadHash`
 *     (SHA-256, same algorithm as logDeadLetter), so secrets cannot leak into
 *     terminal scrollback or log aggregators.
 *   - Replay is at-least-once: a duplicate replay is absorbed by consumer
 *     idempotency (e.g. the settlement worker's `SETNX` lock), never by this
 *     script. Entries whose payload cannot be flattened into stream fields are
 *     kept in the DLQ (fail-closed) instead of being deleted unreplayed.
 *   - Exit codes: 0 = success, 1 = at least one entry failed, 2 = usage or
 *     production confirmation error.
 *
 * @module scripts/replay-dlq
 */

import Redis from "ioredis";
import { randomUUID } from "crypto";
import {
  UsageError,
  fieldsToRecord,
  isReplayablePayload,
  mutationAllowed,
  parseReplayArgs,
  payloadLogFields,
} from "./replay-dlq.lib.js";

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

// fieldsToRecord lives in replay-dlq.lib.ts so tests can cover it without a
// live Redis connection.

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let args;
  try {
    args = parseReplayArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      log("error", "Usage error", { detail: error.message });
      process.exit(2);
    }
    throw error;
  }

  const { queueFilter, limit, dryRun, yes } = args;
  const nodeEnv = process.env.NODE_ENV ?? "development";

  // Production confirmation gate (#1136): mutating replays require --yes,
  // mirroring `pnpm dlq`. --dry-run previews never mutate, so they are exempt.
  if (!mutationAllowed(nodeEnv, dryRun, yes)) {
    log("error", "Refusing to replay the DLQ in production without --yes", {
      nodeEnv,
      dryRun,
    });
    process.exit(2);
  }

  log("info", "DLQ replay started", {
    queueFilter: queueFilter ?? "*",
    limit: Number.isFinite(limit) ? limit : "unlimited",
    dryRun,
    nodeEnv,
  });

  const redis = new Redis(REDIS_URL, {
    // Back off between reconnect attempts; bounded so a dead Redis cannot pin
    // the script in a hot loop (the old `maxRetries` field was not a valid
    // ioredis option and was silently ignored).
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
        const payloadFields = payloadLogFields(message.payload);

        log("info", "Replaying dead-letter entry", {
          entryId,
          queue: queueName,
          originalMessageId: message.messageId,
          reason: message.reason,
          ...payloadFields,
        });

        if (dryRun) {
          // Redacted preview (#1136): payload contents never reach logs.
          log("info", "[DRY-RUN] Would replay entry", {
            entryId,
            queue: queueName,
            ...payloadFields,
          });
          totalReplayed++;
          continue;
        }

        // Fail-closed (#1136): keep unrepresentable payloads in the DLQ for a
        // human instead of deleting them without a re-enqueue.
        if (!isReplayablePayload(message.payload)) {
          totalFailed++;
          log(
            "error",
            "Entry payload is not replayable, keeping it in the DLQ",
            {
              entryId,
              queue: queueName,
              ...payloadFields,
            }
          );
          continue;
        }

        try {
          const targetStream = `${KEY_PREFIX}${queueName}`;
          const rawPayload = message.payload as Record<string, unknown>;

          const xaddFields: string[] = [];
          for (const [key, value] of Object.entries(rawPayload)) {
            xaddFields.push(key, String(value));
          }

          await redis.xadd(targetStream, "*", ...xaddFields);
          await redis.xdel(streamKey, entryId);

          log("info", "Entry replayed and removed from DLQ", {
            entryId,
            queue: queueName,
            targetStream,
            ...payloadFields,
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

    // Fail-closed observability (#1136): partial failures surface as a
    // non-zero exit so scripts and CI can gate on them.
    if (totalFailed > 0) process.exitCode = 1;
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
