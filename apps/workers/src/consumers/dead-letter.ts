import type { ILogger } from "../../../packages/shared/src/logger.js";

export interface DeadLetterMessage {
  id: string;
  queue: string;
  payload: unknown;
  reason: string;
}

export function logDeadLetter(logger: ILogger, message: DeadLetterMessage): void {
  logger.error("Dead letter message recorded", {
    messageId: message.id,
    queue: message.queue,
    reason: message.reason,
    timestamp: new Date().toISOString()
  });
}
