import { describe, it, expect, vi } from "vitest";
import { logDeadLetter, type DeadLetterMessage } from "./dead-letter.js";

describe("Dead Letter Log", () => {
  it("should log the dead letter message with appropriate structured fields", () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    const message: DeadLetterMessage = {
      id: "msg-123",
      queue: "settlement",
      payload: { tradeId: "t-456" },
      reason: "Max retries exceeded",
    };

    return logDeadLetter(mockLogger as any, message).then(() => {
      expect(mockLogger.error).toHaveBeenCalledOnce();
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Job dead-lettered",
        expect.objectContaining({
          messageId: "msg-123",
          queue: "settlement",
          reason: "Max retries exceeded",
          payloadType: "object",
          timestamp: expect.any(String),
        })
      );
    });
  });
});
