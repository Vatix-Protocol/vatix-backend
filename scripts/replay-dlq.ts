#!/usr/bin/env tsx
/**
 * Replay Dead-Letter Queue Admin CLI
 *
 * Reads entries from Redis dead-letter streams and re-enqueues them to their
 * original queues. After a successful replay the dead-letter entry is removed.
 *
 * All parsing/gating/redaction rules live in `scripts/replay-dlq.lib.ts` so
 * they are unit-testable without Redis; this file is the thin I/O shell around
 * them (#1136).
 *
 * Usage:
 *   pnpm replay:dlq                                  # replay all DLQs
 *   pnpm replay:dlq --queue settlement               # one queue only
 *   pnpm replay:dlq --queue settlement --limit 10    # limit entries
 *   pnpm replay:dlq --dry-run                        # preview only
 *   pnpm replay:dlq --yes                            # required to mutate in production
 *
 * Exit codes: 0 success, 1 runtime failure, 2 invalid usage / refused run.
 *
 * @module scripts/replay-dlq
 */

import { randomUUID } from "crypto";
import Redis from "ioredis";
import {
  UsageError,
  assertQueueFilter,
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
const NODE_ENV = process.env.NODE_ENV ?? "development";

/** Correlates every log line emitted by one invocation. */
const CORRELATION_ID = randomUUID();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Structured JSON log line. Carries the invocation's correlationId so an
 * operator can follow one replay end-to-end, and never the payload itself —
 * only its type and SHA-256 hash, matching `logDeadLetter()`'s redaction rule.
 */
function log(
  level: string,
  message: string,
  meta?: Record<string, unknown>
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "replay-dlq",
      correlationId: CORRELATION_ID,
      message,
      ...meta,
    })
  );
}

// ---------------------------------------------------------------------------
// Discover & helpers
// ---------------------------------------------------------------------------

/**
 * Finds the dead-letter streams to replay.
 *
 * The `--queue` filter is interpolated into a SCAN MATCH pattern, so it is
 * validated against QUEUE_NAME_PATTERN first: an unvalidated filter could
 * inject glob metacharacters and sweep unrelated Redis keys (#1136).
 */
async function discoverDLQStreams(
  redis: Redis,
  queueFilter?: string
): Promise<string[]> {
  assertQueueFilter(queueFilter);

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

/** Flattens a dead-letter payload into the `[field, value, ...]` XADD form. */
function toXaddFields(payload: unknown): string[] {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(
    payload as Record<string, unknown>
  )) {
    fields.push(key, String(value));
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { queueFilter, limit, dryRun, yes } = parseReplayArgs(
    process.argv.slice(2)
  );

  log("info", "DLQ replay started", {
    queueFilter: queueFilter ?? "*",
    limit: Number.isFinite(limit) ? limit : null,
    dryRun,
    nodeEnv: NODE_ENV,
  });

  // Production/dev split: a real replay writes to live queues, so it must be
  // acknowledged with --yes outside a local loop. --dry-run mutates nothing and
  // is always allowed.
  if (!mutationAllowed(NODE_ENV, dryRun, yes)) {
    log("error", "Refusing to replay in production without --yes", {
      requiredFlag: "--yes",
    });
    return 2;
  }

  const redis = new Redis(REDIS_URL, {
    maxRetries: 3,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });

  let totalReplayed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  try {
    const streamKeys = await discoverDLQStreams(redis, queueFilter);

    if (streamKeys.length === 0) {
      log("info", "No dead-letter streams found", { prefix: DLQ_PREFIX });
      return 0;
    }

    log("info", "Discovered dead-letter streams", {
      streams: streamKeys,
      count: streamKeys.length,
    });

    for (const streamKey of streamKeys) {
      const queueName = streamKey.slice(DLQ_PREFIX.length);

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

      log("info", "Processing DLQ stream", {
        queue: queueName,
        entries: entries.length,
      });

      for (const [entryId, fields] of entries) {
        if (totalReplayed >= limit) break;

        const message = fieldsToRecord(fields);
        const payloadInfo = payloadLogFields(message.payload);

        // Fail closed on a payload we cannot represent: keep the entry in the
        // DLQ for a human instead of deleting it without re-enqueueing.
        if (!isReplayablePayload(message.payload)) {
          totalSkipped++;
          log("error", "Skipping entry with a non-replayable payload", {
            entryId,
            queue: queueName,
            ...payloadInfo,
            hint: "entry left in the DLQ for manual triage",
          });
          continue;
        }

        log("info", "Replaying dead-letter entry", {
          entryId,
          queue: queueName,
          originalMessageId: message.messageId,
          errorCode: message.errorCode,
          classification: message.classification,
          ...payloadInfo,
        });

        if (dryRun) {
          log("info", "[DRY-RUN] Would replay entry", {
            entryId,
            queue: queueName,
            targetStream: `${KEY_PREFIX}${queueName}`,
            ...payloadInfo,
          });
          totalReplayed++;
          continue;
        }

        try {
          const targetStream = `${KEY_PREFIX}${queueName}`;

          // Re-enqueue first, then delete: a crash between the two leaves the
          // entry in the DLQ (at-least-once) rather than losing the job.
          await redis.xadd(targetStream, "*", ...toXaddFields(message.payload));
          await redis.xdel(streamKey, entryId);

          log("info", "Entry replayed and removed from DLQ", {
            entryId,
            queue: queueName,
            targetStream,
            ...payloadInfo,
          });

          totalReplayed++;
        } catch (error) {
          totalFailed++;
          log("error", "Failed to replay entry", {
            entryId,
            queue: queueName,
            ...payloadInfo,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    log("info", "DLQ replay completed", {
      replayed: totalReplayed,
      failed: totalFailed,
      skipped: totalSkipped,
      dryRun,
    });

    // Non-zero exit so an operator's automation / cron wrapper notices a
    // partial replay instead of treating it as a clean run.
    return totalFailed > 0 ? 1 : 0;
  } finally {
    await redis.quit();
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

void main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      log("error", "Invalid usage", { error: error.message });
      process.exit(2);
    }
    log("error", "DLQ replay script failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
