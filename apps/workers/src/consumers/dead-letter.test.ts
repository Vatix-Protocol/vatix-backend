import { describe, it, expect, vi, beforeEach } from "vitest";

const { store, setImpl, existsImpl, xaddImpl } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  setImpl: vi.fn(),
  existsImpl: vi.fn(),
  xaddImpl: vi.fn(),
}));

// Models ioredis semantics: `SET key value EX ttl NX` resolves to "OK" when the
// key is created and to null when the NX condition blocks the write.
setImpl.mockImplementation(
  async (key: string, _value: string, ...args: string[]) => {
    const nx = args.includes("NX");
    if (nx && store.has(key)) return null;
    store.set(key, "1");
    return "OK";
  }
);
existsImpl.mockImplementation(async (key: string) => store.has(key));
xaddImpl.mockImplementation(async () => "1-0");

vi.mock("../../../../src/services/redis.js", () => ({
  redis: {
    exists: existsImpl,
    set: setImpl,
    xadd: xaddImpl,
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

  // -------------------------------------------------------------------------
  // Atomic dedupe (#1106)
  // -------------------------------------------------------------------------

  it("dedupes via a single atomic SET NX rather than a read-then-write pair", async () => {
    const mockLogger = createMockLogger();
    setImpl.mockClear();
    existsImpl.mockClear();

    await logDeadLetter(mockLogger as any, {
      id: "msg-atomic",
      queue: "settlement",
      payload: { tradeId: "t-atomic" },
      reason: "Max retries exceeded",
    });

    // The previous EXISTS-then-SET implementation had a read-then-write race:
    // two workers dead-lettering the same poison job concurrently both saw
    // "not a duplicate" and both alerted on one incident.
    expect(existsImpl).not.toHaveBeenCalled();
    expect(setImpl).toHaveBeenCalledWith(
      expect.stringContaining("dead-letter:dedupe:settlement:"),
      "1",
      "EX",
      24 * 60 * 60,
      "NX"
    );
  });

  it("reports a duplicate when the NX write is refused (concurrent writer won)", async () => {
    const mockLogger = createMockLogger();
    const message = {
      id: "msg-race",
      queue: "settlement",
      payload: { tradeId: "t-race" },
      reason: "Max retries exceeded",
    };

    expect(await logDeadLetter(mockLogger as any, message)).toEqual({
      duplicate: false,
    });
    expect(
      await logDeadLetter(mockLogger as any, { ...message, id: "msg-race-2" })
    ).toEqual({
      duplicate: true,
    });
  });

  it("still writes the dead letter when the dedupe check fails soft", async () => {
    const mockLogger = createMockLogger();
    setImpl.mockRejectedValueOnce(new Error("READONLY replica"));
    xaddImpl.mockClear();

    const result = await logDeadLetter(mockLogger as any, {
      id: "msg-outage",
      queue: "settlement",
      payload: { tradeId: "t-outage" },
      reason: "Max retries exceeded",
    });

    // Losing the dedupe signal must not cost us the recoverable record.
    expect(result).toEqual({ duplicate: false });
    expect(xaddImpl).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Dead letter dedupe check failed",
      expect.objectContaining({ queue: "settlement" })
    );
  });

  it("reports persisted: false when the dead-letter write itself fails", async () => {
    const mockLogger = createMockLogger();
    xaddImpl.mockRejectedValueOnce(new Error("OOM command not allowed"));

    await logDeadLetter(mockLogger as any, {
      id: "msg-nopersist",
      queue: "settlement",
      payload: { tradeId: "t-nopersist" },
      reason: "Max retries exceeded",
    });

    // Fail *visible*: the message is not in the DLQ, and an operator needs to
    // see that rather than assume the record is safe.
    const call = mockLogger.error.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({
      messageId: "msg-nopersist",
      persisted: false,
      persistenceError: "OOM command not allowed",
    });
  });
});
