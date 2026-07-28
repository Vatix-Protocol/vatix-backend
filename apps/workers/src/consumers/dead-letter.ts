import { createHash } from "crypto";
import type { ILogger } from "../../../../packages/shared/src/logger.js";
import { redis } from "../../../../src/services/redis.js";

export interface DeadLetterMessage {
  id: string;
  queue: string;
  payload: unknown;
  reason: string;
}

const DEAD_LETTER_STREAM_PREFIX = process.env.REDIS_KEY_PREFIX ?? "vatix:";
/** How long a payload hash is remembered for dedupe purposes. */
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

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
 * for this queue within the dedupe window, then (re)marks it as seen.
 */
async function checkAndMarkDuplicate(
  logger: ILogger,
  queue: string,
  payloadHash: string
): Promise<boolean> {
  const key = dedupeKey(queue, payloadHash);
  try {
    const duplicate = await redis.exists(key);
    await redis.set(key, "1", DEDUPE_TTL_SECONDS);
    return duplicate;
  } catch (error) {
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

  try {
    await (
      redis as unknown as {
        xadd: (
          streamKey: string,
          id: string,
          ...fields: string[]
        ) => Promise<string>;
      }
    ).xadd(
      stream,
      "*",
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
      timestamp,
      persisted: true,
      stream,
    });
  } catch (error) {
    logger.error("Job dead-lettered", {
      messageId: message.id,
      queue: message.queue,
      reason: message.reason,
      payloadType: typeof message.payload,
      payloadHash,
      duplicate,
      timestamp,
      persisted: false,
      persistenceError: error instanceof Error ? error.message : String(error),
    });
  }

  return { duplicate };
}
