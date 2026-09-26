/**
 * Pure helpers for the raw-stream DLQ replay CLI (issue #1136).
 *
 * Extracted from `scripts/replay-dlq.ts` so argument parsing, the production
 * mutation gate, and payload redaction are unit-testable without touching
 * Redis. Everything in this module is side-effect free.
 *
 * @module scripts/replay-dlq.lib
 */
import { createHash } from "crypto";

/** Thrown for invalid CLI input; the script exits with code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Queue/stream names accepted by `--queue`. Bounded to an unambiguous
 * character set so a filter can never inject SCAN MATCH glob metacharacters
 * (`*`, `?`, `[`, ...) and sweep unrelated Redis keys (#1136 adversarial
 * input).
 */
export const QUEUE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

/**
 * Validates an optional `--queue` filter before it is interpolated into a
 * Redis SCAN MATCH pattern.
 *
 * The filter is a glob fragment, so an unvalidated value (`*`, `?`, `[a-z]`)
 * would widen the sweep to unrelated keys and could replay another queue's
 * dead letters. Rejecting the whole filter keeps the blast radius to the
 * queues the operator named. An absent filter is valid and means "all".
 *
 * @throws {UsageError} when the filter is present but not a plain queue name
 */
export function assertQueueFilter(queueFilter?: string): void {
  if (queueFilter === undefined) return;
  if (!QUEUE_NAME_PATTERN.test(queueFilter)) {
    throw new UsageError(
      "--queue must match [A-Za-z0-9][A-Za-z0-9:_-]* (got: invalid value)"
    );
  }
}

export interface ReplayArgs {
  /** Only replay this queue's dead-letter stream; undefined = all streams. */
  queueFilter?: string;
  /** Max entries to replay across all streams. */
  limit: number;
  /** Preview only — never mutates Redis. */
  dryRun: boolean;
  /** Required to mutate when NODE_ENV=production. */
  yes: boolean;
}

/**
 * Parse and validate CLI arguments for the replay script.
 *
 * Fails closed on anything unexpected: unknown flags, a missing `--queue`
 * value, an invalid queue name, or a non-positive-integer `--limit` all throw
 * {@link UsageError} instead of silently falling back to defaults (the old
 * parser quietly replayed *everything* when `--limit` was malformed).
 */
export function parseReplayArgs(argv: string[]): ReplayArgs {
  let queueFilter: string | undefined;
  let limit = Number.POSITIVE_INFINITY;
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--queue") {
      const value = argv[++i];
      if (!value) {
        throw new UsageError("--queue requires a value");
      }
      if (!QUEUE_NAME_PATTERN.test(value)) {
        throw new UsageError(
          `--queue must match ${QUEUE_NAME_PATTERN.source}, got: ${JSON.stringify(value)}`
        );
      }
      queueFilter = value;
    } else if (arg === "--limit") {
      const raw = argv[++i] ?? "";
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 1 || String(n) !== raw.trim()) {
        throw new UsageError(
          `--limit must be a positive integer, got: ${JSON.stringify(raw)}`
        );
      }
      limit = n;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      yes = true;
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  return { queueFilter, limit, dryRun, yes };
}

/**
 * Production confirmation gate for state-mutating runs (mirrors the BullMQ
 * DLQ CLI, scripts/dlq.ts): in `NODE_ENV=production` a replay that actually
 * writes must be acknowledged with `--yes`. `--dry-run` previews never need
 * it because they mutate nothing (#1136).
 */
export function mutationAllowed(
  nodeEnv: string,
  dryRun: boolean,
  yes: boolean
): boolean {
  if (dryRun) return true;
  if (nodeEnv === "production" && !yes) return false;
  return true;
}

/** Parse a Redis stream entry's flat `[field, value, ...]` array into a record. */
export function fieldsToRecord(fields: string[]): Record<string, unknown> {
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

/**
 * Stable SHA-256 of the payload — same algorithm as `logDeadLetter()`'s
 * `payloadHash` (apps/workers/src/consumers/dead-letter.ts). Used in logs so
 * operators can correlate an entry without ever printing payload contents.
 */
export function computePayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Ops-safe log fields for a dead-letter payload: type + hash only, never the
 * payload itself (secrets must not reach logs, #1136).
 */
export function payloadLogFields(payload: unknown): {
  payloadType: string;
  payloadHash: string;
} {
  return {
    payloadType: payload === null ? "null" : typeof payload,
    payloadHash: computePayloadHash(payload),
  };
}

/**
 * A replayable payload must be a non-empty plain object: the re-enqueue path
 * flattens it into `XADD` fields. Primitives, arrays, and empty objects cannot
 * be represented and must be skipped fail-closed (kept in the DLQ for a
 * human) instead of being deleted without re-enqueue (#1136).
 */
export function isReplayablePayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    Object.keys(payload).length > 0
  );
}
