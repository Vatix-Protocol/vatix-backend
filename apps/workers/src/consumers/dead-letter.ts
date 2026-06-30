import type { ILogger } from "../../../../packages/shared/src/logger.js";
import { redis } from "../../../../src/services/redis.js";

export interface DeadLetterMessage {
  id: string;
  queue: string;
  payload: unknown;
  reason: string;
}

const DEAD_LETTER_STREAM_PREFIX = process.env.REDIS_KEY_PREFIX ?? "vatix:";

export async function logDeadLetter(
  logger: ILogger,
  message: DeadLetterMessage
): Promise<void> {
  const timestamp = new Date().toISOString();
  const stream = `${DEAD_LETTER_STREAM_PREFIX}dead-letter:${message.queue}`;

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
      "timestamp",
      timestamp
    );

    logger.error("Job dead-lettered", {
      messageId: message.id,
      queue: message.queue,
      reason: message.reason,
      payloadType: typeof message.payload,
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
      timestamp,
      persisted: false,
      persistenceError: error instanceof Error ? error.message : String(error),
    });
  }
}
