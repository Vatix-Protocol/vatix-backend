#!/usr/bin/env tsx
/**
 * Replay Dead-Letter Queue Admin CLI
 *
 * Reads entries from Redis dead-letter streams and atomically re-enqueues
 * valid payloads before removing their source entries.
 *
 * Usage:
 *   pnpm tsx scripts/replay-dlq.ts                                # replay all DLQs
 *   pnpm tsx scripts/replay-dlq.ts --queue settlement             # settlement or oracle only
 *   pnpm tsx scripts/replay-dlq.ts --queue settlement --limit 10  # limit entries
 *   pnpm tsx scripts/replay-dlq.ts --dry-run                      # preview only
 *
 * @module scripts/replay-dlq
 */

import Redis from "ioredis";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX ?? "vatix:";
const DLQ_PREFIX = `${KEY_PREFIX}dead-letter:`;
const DLQ_QUEUES = ["settlement", "oracle"] as const;
type DlqQueue = (typeof DLQ_QUEUES)[number];

function isDlqQueue(value: string): value is DlqQueue {
  return DLQ_QUEUES.some((queue) => queue === value);
}

const REPLAY_ENTRY_SCRIPT = `
local existing = redis.call('GET', KEYS[3])
if existing then
  redis.call('XDEL', KEYS[1], ARGV[1])
  redis.call('DEL', KEYS[3])
  return existing
end
local targetId = redis.call('XADD', KEYS[2], '*', unpack(ARGV, 2))
redis.call('SET', KEYS[3], targetId)
redis.call('XDEL', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[3])
return targetId
`;

export interface ReplayArgs {
  queueFilter?: DlqQueue;
  limit: number;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseArgs(args = process.argv.slice(2)): ReplayArgs {
  let queueFilter: DlqQueue | undefined;
  let limit = Infinity;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--queue") {
      const value = args[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--queue requires a queue name");
      }
      if (!isDlqQueue(value)) {
        throw new Error(
          `Invalid --queue value "${value}"; expected ${DLQ_QUEUES.join(" or ")}`
        );
      }
      queueFilter = value;
    } else if (args[i] === "--limit") {
      const value = args[++i];
      if (!value || !/^[1-9]\d*$/.test(value)) {
        throw new Error("--limit requires a positive integer");
      }
      limit = Number(value);
      if (!Number.isSafeInteger(limit)) {
        throw new Error("--limit must be a safe positive integer");
      }
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument "${args[i]}"`);
    }
  }

  return { queueFilter, limit, dryRun };
}

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
  queueFilter?: DlqQueue
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

  return keys.filter((key) => isDlqQueue(key.slice(DLQ_PREFIX.length))).sort();
}

export function fieldsToRecord(fields: string[]): Record<string, unknown> {
  if (fields.length % 2 !== 0) {
    throw new Error(
      "Malformed dead-letter entry: fields must be key/value pairs"
    );
  }

  const record: Record<string, unknown> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key === "payload") {
      try {
        record[key] = JSON.parse(value);
      } catch {
        throw new Error("Malformed dead-letter entry: payload is not valid JSON");
      }
    } else {
      record[key] = value;
    }
  }
  return record;
}

export async function replayDLQEntry(
  redis: Pick<Redis, "eval">,
  streamKey: string,
  queueName: DlqQueue,
  entryId: string,
  message: Record<string, unknown>
): Promise<string> {
  const payload = message.payload;
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new Error(
      "Malformed dead-letter entry: payload must be a JSON object"
    );
  }

  const xaddFields = Object.entries(payload).flatMap(([key, value]) => [
    key,
    String(value),
  ]);
  if (xaddFields.length === 0) {
    throw new Error("Malformed dead-letter entry: payload must not be empty");
  }

  const targetStream = `${KEY_PREFIX}${queueName}`;
  const replayKey = `${KEY_PREFIX}dlq-replay:${queueName}:${entryId}`;
  const targetId = await redis.eval(
    REPLAY_ENTRY_SCRIPT,
    3,
    streamKey,
    targetStream,
    replayKey,
    entryId,
    ...xaddFields
  );

  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("Redis did not confirm the replayed stream entry");
  }

  return targetId;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const { queueFilter, limit, dryRun } = parseArgs();

  log("info", "DLQ replay started", {
    queueFilter: queueFilter ?? "*",
    dryRun,
  });

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
      const queueName = streamKey.slice(DLQ_PREFIX.length) as DlqQueue;

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

        try {
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

          const targetId = await replayDLQEntry(
            redis,
            streamKey,
            queueName,
            entryId,
            message
          );

          log("info", "Entry replayed and removed from DLQ", {
            entryId,
            queue: queueName,
            targetStream: `${KEY_PREFIX}${queueName}`,
            targetId,
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
    if (totalFailed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await redis.quit();
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  void main().catch((error) => {
    log("error", "DLQ replay script failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
