import type { ILogger } from "../../../packages/shared/src/logger.js";

export interface DeadLetterMessage {
  id: string;
  queue: string;
  payload: unknown;
  reason: string;
}

export function logDeadLetter(logger: ILogger, message: DeadLetterMessage): void {
  logger.error("Job dead-lettered", {
    messageId: message.id,
    queue: message.queue,
    reason: message.reason,
    payloadType: typeof message.payload,
    timestamp: new Date().toISOString(),
  });
}
