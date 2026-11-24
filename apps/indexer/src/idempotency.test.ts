import { describe, it, expect } from "vitest";
import {
  generateIdempotencyKey,
  parseEventId,
  IdempotencyError,
  IdempotencyErrorCode,
} from "./idempotency.js";

describe("parseEventId", () => {
  it("parses a canonical Stellar event id", () => {
    expect(parseEventId("0000000042-0000000001-0000000003")).toEqual({
      ledger: 42,
      txIndex: 1,
      eventIndex: 3,
    });
  });

  it("rejects malformed event ids", () => {
    expect(() => parseEventId("not-an-event-id")).toThrow(IdempotencyError);
    try {
      parseEventId("not-an-event-id");
    } catch (err) {
      expect((err as IdempotencyError).code).toBe(
        IdempotencyErrorCode.INVALID_EVENT_ID
      );
    }
  });
});

describe("generateIdempotencyKey", () => {
  it("is deterministic for the same event", () => {
    const event = {
      id: "0000000042-0000000001-0000000003",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    };
    expect(generateIdempotencyKey(event).key).toBe(
      generateIdempotencyKey(event).key
    );
  });

  it("produces different keys for different contract ids with the same event id", () => {
    const id = "0000000042-0000000001-0000000003";
    const a = generateIdempotencyKey({
      id,
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    });
    const b = generateIdempotencyKey({
      id,
      contractId: "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBY3M",
    });
    expect(a.key).not.toBe(b.key);
  });
});
