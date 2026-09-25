import { describe, it, expect, vi, beforeEach } from "vitest";

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));

vi.mock("../../../../src/services/redis.js", () => ({
  redis: {
    exists: vi.fn(async (key: string) => store.has(key)),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    xadd: vi.fn(async () => "1-0"),
  },
}));

import { logDeadLetter, type DeadLetterMessage } from "./dead-letter.js";

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe("Dead Letter Log", () => {
  beforeEach(() => {
    store.clear();
  });

  it("should log the dead letter message with appropriate structured fields", () => {
    const mockLogger = createMockLogger();

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
          payloadHash: expect.any(String),
          duplicate: false,
          timestamp: expect.any(String),
        })
      );
    });
  });

  it("should not flag the first occurrence of a payload as a duplicate", async () => {
    const mockLogger = createMockLogger();
    const message: DeadLetterMessage = {
      id: "msg-1",
      queue: "settlement",
      payload: { tradeId: "t-1" },
      reason: "Max retries exceeded",
    };

    const result = await logDeadLetter(mockLogger as any, message);

    expect(result).toEqual({ duplicate: false });
  });

  it("should flag a repeat insert of the same payload+queue as a duplicate", async () => {
    const mockLogger = createMockLogger();
    const message: DeadLetterMessage = {
      id: "msg-2",
      queue: "settlement",
      payload: { tradeId: "t-2" },
      reason: "Max retries exceeded",
    };

    const first = await logDeadLetter(mockLogger as any, message);
    const second = await logDeadLetter(mockLogger as any, {
      ...message,
      id: "msg-3",
    });

    expect(first).toEqual({ duplicate: false });
    expect(second).toEqual({ duplicate: true });
    expect(mockLogger.error).toHaveBeenLastCalledWith(
      "Job dead-lettered",
      expect.objectContaining({ duplicate: true })
    );
  });

  it("should compute the same payload hash for identical payloads and a different hash for different payloads", async () => {
    const mockLogger = createMockLogger();

    await logDeadLetter(mockLogger as any, {
      id: "msg-4",
      queue: "oracle",
      payload: { marketId: "m-1" },
      reason: "Poison message",
    });
    const hashA = mockLogger.error.mock.calls[0][1].payloadHash;

    await logDeadLetter(mockLogger as any, {
      id: "msg-5",
      queue: "oracle",
      payload: { marketId: "m-2" },
      reason: "Poison message",
    });
    const hashB = mockLogger.error.mock.calls[1][1].payloadHash;

    expect(hashA).not.toEqual(hashB);
  });

  it("should not treat identical payloads on different queues as duplicates", async () => {
    const mockLogger = createMockLogger();
    const payload = { tradeId: "t-shared" };

    const onQueueA = await logDeadLetter(mockLogger as any, {
      id: "msg-6",
      queue: "settlement",
      payload,
      reason: "Max retries exceeded",
    });
    const onQueueB = await logDeadLetter(mockLogger as any, {
      id: "msg-7",
      queue: "oracle",
      payload,
      reason: "Max retries exceeded",
    });

    expect(onQueueA).toEqual({ duplicate: false });
    expect(onQueueB).toEqual({ duplicate: false });
  });
});
