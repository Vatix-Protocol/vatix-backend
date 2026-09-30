import { createHash } from "crypto";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import { redis } from "../../../../src/services/redis.js";

export interface DeadLetterMessage {
  id: string;
  queue: string;
  payload: unknown;
  reason: string;
  /** Machine-readable error code (e.g. "STELLAR_TX_BAD_AUTH") classifying the failure, when known (#870). */
  errorCode?: string;
  /** Failure classification: "transient" | "fatal" | "invalid_input" (#870). */
  classification?: string;
}

const DEAD_LETTER_STREAM_PREFIX = process.env.REDIS_KEY_PREFIX ?? "vatix:";
/** How long a payload hash is remembered for dedupe purposes. */
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Upper bound on the dead-letter stream, applied with approximate `MAXLEN ~`
 * trimming (the same mechanism `redis-submission-queue.ts` and
 * `src/services/audit.ts` use for their streams).
 *
 * Without a cap, `vatix:dead-letter:<queue>` grows without bound: a poison
 * message that redelivers on every deploy, or a dependency outage that fails
 * every job in the queue, appends an entry per failure for as long as the
 * worker is up. That is a memory-exhaustion path on the exact component that
 * exists to record failures, and it turns an incident into an outage.
 *
 * The cap is a retention bound, not a correctness one: the BullMQ `failed` set
 * (`removeOnFail: false`, see `docs/dead-letter-log.md`) is the durable record
 * and is unaffected. This is deliberately generous so a real incident is
 * fully captured, and `0` disables trimming for operators who archive the
 * stream out of band.
 */
const DEFAULT_MAX_STREAM_LENGTH = 100_000;

function maxStreamLength(): number {
  const raw = process.env.DEAD_LETTER_MAX_STREAM_LENGTH;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_STREAM_LENGTH;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    // A malformed cap must not silently disable the bound, so fall back to the
    // default rather than parsing `Number("1000; DROP")` as 1000.
    return DEFAULT_MAX_STREAM_LENGTH;
  }
  return parsed;
}

/**
 * Stable SHA-256 hash of the payload, used to recognize replays of the same
 * failure as duplicates rather than distinct incidents.
 */
function computePayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function dedupeKey(queue: string, payloadHash: string): string {
  return `${DEAD_LETTER_STREAM_PREFIX}dead-letter:dedupe:${queue}:${payloadHash}`;
}

/**
 * Returns true if a message with this exact payload was already dead-lettered
 * for this queue within the dedupe window.
 *
 * Uses a single atomic `SET key 1 EX <ttl> NX` rather than `EXISTS` followed by
 * `SET`: the two-call version has a read-then-write race, so two workers
 * dead-lettering the same poison job concurrently both observe "not a
 * duplicate" and both raise an alert for one incident. The atomic form returns
 * `null` exactly when a concurrent writer got there first, which is the
 * duplicate case. The `NX` write also refreshes the TTL on a first sighting,
 * so the key expires 24h after the *last* occurrence.
 */
async function checkAndMarkDuplicate(
  logger: ILogger,
  queue: string,
  payloadHash: string
): Promise<boolean> {
  const key = dedupeKey(queue, payloadHash);
  try {
    const result = await redis.set(key, "1", "EX", DEDUPE_TTL_SECONDS, "NX");
    // ioredis resolves to "OK" when the key was created and to null when the
    // NX condition blocked the write because the key already existed.
    return result === null;
  } catch (error) {
    // Fail soft on the *dedupe* path only: losing the duplicate signal must not
    // cost us the dead-letter write itself, which is what makes the message
    // recoverable.
    logger.warn("Dead letter dedupe check failed", {
      queue,
      payloadHash,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function logDeadLetter(
  logger: ILogger,
  message: DeadLetterMessage
): Promise<{ duplicate: boolean }> {
  const timestamp = new Date().toISOString();
  const stream = `${DEAD_LETTER_STREAM_PREFIX}dead-letter:${message.queue}`;
  const payloadHash = computePayloadHash(message.payload);
  const duplicate = await checkAndMarkDuplicate(
    logger,
    message.queue,
    payloadHash
  );
  const maxLength = maxStreamLength();

  try {
    await (
      redis as unknown as {
        xadd: (...args: (string | number)[]) => Promise<string>;
      }
    ).xadd(
      ...(maxLength > 0
        ? [stream, "MAXLEN", "~", String(maxLength), "*"]
        : [stream, "*"]),
      "messageId",
      message.id,
      "queue",
      message.queue,
      "reason",
      message.reason,
      "payloadType",
      typeof message.payload,
      "payload",
      JSON.stringify(message.payload),
      "payloadHash",
      payloadHash,
      "duplicate",
      String(duplicate),
      "errorCode",
      message.errorCode ?? "UNKNOWN",
      "classification",
      message.classification ?? "unknown",
      "timestamp",
      timestamp
    );

    logger.error("Job dead-lettered", {
      messageId: message.id,
      queue: message.queue,
      reason: message.reason,
      payloadType: typeof message.payload,
      payloadHash,
      duplicate,
      errorCode: message.errorCode,
      classification: message.classification,
      timestamp,
      persisted: true,
      stream,
      maxLength,
    });
  } catch (error) {
    logger.error("Job dead-lettered", {
      messageId: message.id,
      queue: message.queue,
      reason: message.reason,
      payloadType: typeof message.payload,
      payloadHash,
      duplicate,
      errorCode: message.errorCode,
      classification: message.classification,
      timestamp,
      persisted: false,
      persistenceError: error instanceof Error ? error.message : String(error),
    });
  }

  return { duplicate };
}
