/**
 * Raw-stream dead-letter replay — issue #1136.
 *
 * `logDeadLetter()` (dead-letter.ts) records non-retryable poison messages on
 * the `{prefix}dead-letter:{queue}` Redis streams. Until now the only way to
 * move those entries back onto their live streams was
 * `scripts/replay-dlq.ts`, a top-level script with no unit tests, no
 * production guard, and no structured failure accounting. This module holds
 * the replay logic so it can be tested without a Redis server; the CLI is a
 * thin wrapper over it.
 *
 * Safety properties this module guarantees (see docs/dead-letter-log.md):
 *
 *   - **Fail-closed on write**: an entry is appended to the live stream *and*
 *     only then deleted from the DLQ. A failure at any point leaves the entry
 *     in the DLQ, so a crashed replay never loses a message. Per-entry
 *     failures are collected, not thrown, and the caller exits non-zero.
 *   - **Idempotent per entry**: a re-run of a partially-completed replay
 *     re-processes only what is still in the DLQ; already-replayed entries are
 *     gone. Entries with no usable payload are skipped rather than replayed as
 *     an empty record that a consumer would re-poison.
 *   - **Deny-by-default on the queue filter**: `--queue` is matched against a
 *     conservative character allowlist before it is interpolated into a Redis
 *     `SCAN` pattern, so a glob-ish value cannot widen the match to other key
 *     namespaces.
 *   - **No payload leakage**: payloads are only ever surfaced by an explicit
 *     dry run; logs carry entry/queue/message ids and the payload type.
 *
 * This is separate from `bullmq-dlq.ts` (issue #953, `pnpm dlq`), which
 * operates on the BullMQ `failed` set for retry-exhausted jobs.
 *
 * @module apps/workers/src/consumers/stream-dlq-replay
 */

/** Characters allowed in a `--queue` filter / stream suffix. */
const SAFE_QUEUE_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

export const DEFAULT_SCAN_COUNT = 100;

/** Thrown when operator-supplied arguments are unsafe or malformed. */
export class DlqUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DlqUsageError";
  }
}

/** Minimal slice of the ioredis client the replay helper touches. */
export interface RedisLike {
  scan(cursor: string, ...args: string[]): Promise<[string, string[]]>;
  xrange(
    key: string,
    start: string,
    end: string
  ): Promise<Array<[string, string[]]>>;
  xadd(key: string, id: string, ...fields: string[]): Promise<string>;
  xdel(key: string, ...ids: string[]): Promise<number>;
}

export interface DeadLetterEntry {
  /** Redis stream entry id, e.g. "1712345678901-0". */
  entryId: string;
  /** Queue name (the DLQ stream key's suffix). */
  queue: string;
  /** Original job id, when the dead-letter record carried one. */
  originalMessageId?: string;
  /** Why the message was dead-lettered, when recorded. */
  reason?: string;
  /** Parsed payload, or undefined when absent/unparseable. */
  payload?: unknown;
}

export interface ReplayOptions {
  /** Replay only this queue. Omit to process every DLQ stream. */
  queueFilter?: string;
  /** Maximum number of entries to replay (dry-run previews count too). */
  limit?: number;
  /** Preview without mutating Redis. */
  dryRun?: boolean;
}

export interface ReplayFailure {
  entryId: string;
  queue: string;
  error: string;
}

export interface ReplaySummary {
  streams: string[];
  scanned: number;
  replayed: number;
  skipped: number;
  dryRun: boolean;
  failures: ReplayFailure[];
}

/**
 * Validate a `--queue` filter. Throws {@link DlqUsageError} when the value
 * could widen a Redis `SCAN` pattern or address an unintended key.
 */
export function assertSafeQueueFilter(queueFilter: string | undefined): void {
  if (queueFilter === undefined) return;
  if (!SAFE_QUEUE_NAME.test(queueFilter)) {
    throw new DlqUsageError(
      "--queue must be 1-128 characters of [A-Za-z0-9_.:-] so it cannot " +
        "match keys outside the dead-letter namespace"
    );
  }
}

/** Convert a Redis stream field array into a record, JSON-parsing `payload`. */
export function fieldsToRecord(fields: string[]): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
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

/** Normalize a scanned field array into a typed {@link DeadLetterEntry}. */
export function toDeadLetterEntry(
  entryId: string,
  fields: string[],
  queue: string
): DeadLetterEntry {
  const record = fieldsToRecord(fields);
  const payload = record.payload;
  return {
    entryId,
    queue,
    originalMessageId:
      typeof record.messageId === "string" ? record.messageId : undefined,
    reason: typeof record.reason === "string" ? record.reason : undefined,
    payload:
      typeof payload === "object" && payload !== null ? payload : undefined,
  };
}

/**
 * Flatten a payload object into Redis stream field pairs. Returns an empty
 * array when there is nothing replayable, which the caller treats as a skip —
 * appending an empty record would only re-poison the consumer.
 */
export function payloadToStreamFields(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const fields: string[] = [];
  for (const [key, value] of Object.entries(
    payload as Record<string, unknown>
  )) {
    if (value === undefined) continue;
    fields.push(key, String(value));
  }
  return fields;
}

/**
 * Discover DLQ stream keys, paginating SCAN to completion. Results are sorted
 * so replay order is deterministic across runs.
 */
export async function discoverDlqStreams(
  redis: RedisLike,
  dlqPrefix: string,
  queueFilter?: string
): Promise<string[]> {
  assertSafeQueueFilter(queueFilter);
  const pattern = queueFilter ? `${dlqPrefix}${queueFilter}` : `${dlqPrefix}*`;

  const keys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, batch] = await redis.scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      String(DEFAULT_SCAN_COUNT)
    );
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== "0");

  return [...new Set(keys)].sort();
}

/**
 * Replay dead-letter entries from the DLQ streams back onto their live
 * streams. Never throws for a per-entry failure — failures are collected in
 * the returned summary so the CLI can report them and exit non-zero.
 */
export async function replayDeadLetters(
  redis: RedisLike,
  opts: ReplayOptions & { dlqPrefix: string; keyPrefix: string }
): Promise<ReplaySummary> {
  const { dlqPrefix, keyPrefix } = opts;
  const dryRun = opts.dryRun ?? false;
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;

  const streams = await discoverDlqStreams(redis, dlqPrefix, opts.queueFilter);
  const summary: ReplaySummary = {
    streams,
    scanned: 0,
    replayed: 0,
    skipped: 0,
    dryRun,
    failures: [],
  };

  for (const streamKey of streams) {
    if (summary.replayed >= limit) break;

    const queue = streamKey.slice(dlqPrefix.length);
    // Defence in depth: a key discovered by SCAN must still resolve to a
    // single, safe queue suffix before it becomes part of a live key name.
    try {
      assertSafeQueueFilter(queue);
    } catch (error) {
      summary.skipped++;
      summary.failures.push({
        entryId: streamKey,
        queue,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const entries = await redis.xrange(streamKey, "-", "+");
    if (entries.length === 0) continue;

    for (const [entryId, fields] of entries) {
      if (summary.replayed >= limit) break;

      const entry = toDeadLetterEntry(entryId, fields, queue);
      summary.scanned++;

      const xaddFields = payloadToStreamFields(entry.payload);
      if (xaddFields.length === 0) {
        // Nothing replayable (missing or scalar payload). Keep the entry in
        // the DLQ so an operator can inspect it — deleting would lose it.
        summary.skipped++;
        continue;
      }

      if (dryRun) {
        summary.replayed++;
        continue;
      }

      try {
        // Append first, delete second. A crash between the two leaves a
        // duplicate rather than a lost message, which is the safe direction
        // for a money-path queue.
        await redis.xadd(`${keyPrefix}${queue}`, "*", ...xaddFields);
        await redis.xdel(streamKey, entryId);
        summary.replayed++;
      } catch (error) {
        summary.failures.push({
          entryId,
          queue,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return summary;
}
