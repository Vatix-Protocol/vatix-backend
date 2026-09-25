import { describe, it, expect, vi } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import {
  parseMarketCreatedChainEvent,
  parseMarketCreatedEvents,
} from "./marketCreatedParser.js";
import { MarketCreatedParseError } from "./types.js";
import type { RawChainEvent } from "./types.js";
import type { Telemetry } from "./telemetry.js";

// ─── Real XDR fixtures, matching contracts/market/src/events.rs ────────────
//
// #[contractevent]
// pub struct MarketCreatedEvent {
//     #[topic] pub market_id: u32,
//     pub question: String,
//     pub end_time: u64,
// }
//
// Soroban's #[contractevent] macro derives the topic symbol by snake_casing
// the struct name including its "Event" suffix, so the real topic is
// "market_created_event" (verified against the contract's own unit test
// `test_emit_market_created` in events.rs).

const XDR = {
  topic: {
    marketCreatedEvent: "AAAADwAAABRtYXJrZXRfY3JlYXRlZF9ldmVudA==",
    marketResolvedEvent: "AAAADwAAABVtYXJrZXRfcmVzb2x2ZWRfZXZlbnQAAAA=",
  },
  marketId: {
    42: "AAAAAwAAACo=",
    7: "AAAAAwAAAAc=",
  },
  // ScvMap { question: "Will BTC hit $100k?", end_time: 1234567890 }
  value: {
    valid:
      "AAAAEQAAAAEAAAACAAAADwAAAAhxdWVzdGlvbgAAAA4AAAATV2lsbCBCVEMgaGl0ICQxMDBrPwAAAAAPAAAACGVuZF90aW1lAAAABQAAAABJlgLS",
  },
};

function makeEvent(overrides: Partial<RawChainEvent> = {}): RawChainEvent {
  return {
    id: "evt-market-1",
    ledger: 555,
    ledgerClosedAt: "2024-09-01T00:00:00Z",
    contractId: "CMARKET",
    type: "contract",
    pagingToken: "token-market-1",
    valueXdr: XDR.value.valid,
    topicsXdr: [XDR.topic.marketCreatedEvent, XDR.marketId[42]],
    ...overrides,
  };
}

describe("parseMarketCreatedChainEvent", () => {
  it("parses the real on-chain market_created_event shape", () => {
    const m = parseMarketCreatedChainEvent(makeEvent());

    expect(m.eventId).toBe("evt-market-1");
    expect(m.marketId).toBe("42");
    expect(m.question).toBe("Will BTC hit $100k?");
    expect(m.endTime).toBe(new Date(1234567890 * 1000).toISOString());
    expect(m.status).toBe("ACTIVE");
    expect(m.oracleAddress).toBe("");
  });

  it("carries ledger metadata through", () => {
    const m = parseMarketCreatedChainEvent(
      makeEvent({ ledger: 999, contractId: "CXYZ" })
    );
    expect(m.ledger).toBe(999);
    expect(m.contractId).toBe("CXYZ");
  });

  it("reads market_id from the second topic, not the value map", () => {
    const m = parseMarketCreatedChainEvent(
      makeEvent({ topicsXdr: [XDR.topic.marketCreatedEvent, XDR.marketId[7]] })
    );
    expect(m.marketId).toBe("7");
  });

  it("throws MarketCreatedParseError when topic is not market_created_event", () => {
    expect(() =>
      parseMarketCreatedChainEvent(
        makeEvent({
          topicsXdr: [XDR.topic.marketResolvedEvent, XDR.marketId[42]],
        })
      )
    ).toThrow(MarketCreatedParseError);
  });

  it("throws MarketCreatedParseError when topicsXdr is empty", () => {
    expect(() =>
      parseMarketCreatedChainEvent(makeEvent({ topicsXdr: [] }))
    ).toThrow(MarketCreatedParseError);
  });

  it("throws MarketCreatedParseError when the market_id topic is missing", () => {
    expect(() =>
      parseMarketCreatedChainEvent(
        makeEvent({ topicsXdr: [XDR.topic.marketCreatedEvent] })
      )
    ).toThrow(MarketCreatedParseError);
  });

  it("throws MarketCreatedParseError on malformed value XDR", () => {
    expect(() =>
      parseMarketCreatedChainEvent(makeEvent({ valueXdr: "not-valid-xdr!!!" }))
    ).toThrow(MarketCreatedParseError);
  });

  it("error carries the eventId", () => {
    try {
      parseMarketCreatedChainEvent(makeEvent({ id: "bad-evt", topicsXdr: [] }));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MarketCreatedParseError).eventId).toBe("bad-evt");
    }
  });

  // ── #986: reject rather than truncate an over-length question ───────────
  // Truncating a question that exceeds the contract's cap would desync the
  // indexed `markets.question` column from what actually landed on chain.
  function makeValueXdrWithQuestion(question: string): string {
    return nativeToScVal(
      { question, end_time: 1234567890n },
      { type: "instance" }
    ).toXDR("base64");
  }

  it("accepts a question exactly at the 499-char contract cap", () => {
    const question = "Q".repeat(499);
    const m = parseMarketCreatedChainEvent(
      makeEvent({ valueXdr: makeValueXdrWithQuestion(question) })
    );
    expect(m.question).toBe(question);
    expect(m.question).toHaveLength(499);
  });

  it("throws MarketCreatedParseError when question exceeds the 499-char contract cap", () => {
    const question = "Q".repeat(500);
    expect(() =>
      parseMarketCreatedChainEvent(
        makeEvent({ valueXdr: makeValueXdrWithQuestion(question) })
      )
    ).toThrow(MarketCreatedParseError);
  });

  it("does not truncate an over-length question in the thrown error", () => {
    const question = "Q".repeat(600);
    try {
      parseMarketCreatedChainEvent(
        makeEvent({ valueXdr: makeValueXdrWithQuestion(question) })
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MarketCreatedParseError).message).toContain("600");
      expect((err as MarketCreatedParseError).message).toContain("499");
    }
  });
});

describe("parseMarketCreatedEvents (batch)", () => {
  it("parses multiple valid events", () => {
    const events = [
      makeEvent({ id: "e1" }),
      makeEvent({
        id: "e2",
        topicsXdr: [XDR.topic.marketCreatedEvent, XDR.marketId[7]],
      }),
    ];
    const { markets, errors } = parseMarketCreatedEvents(events);
    expect(markets).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  it("silently skips non-market-created events", () => {
    const events = [
      makeEvent({
        id: "e1",
        topicsXdr: [XDR.topic.marketResolvedEvent, XDR.marketId[42]],
      }),
      makeEvent({ id: "e2" }),
    ];
    const { markets, errors } = parseMarketCreatedEvents(events);
    expect(markets).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("collects errors without dropping other markets", () => {
    const events = [
      makeEvent({ id: "e1" }),
      makeEvent({ id: "e2", valueXdr: "bad-xdr" }),
      makeEvent({
        id: "e3",
        topicsXdr: [XDR.topic.marketCreatedEvent, XDR.marketId[7]],
      }),
    ];
    const { markets, errors } = parseMarketCreatedEvents(events);
    expect(markets).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(MarketCreatedParseError);
    expect(errors[0].eventId).toBe("e2");
  });

  it("returns empty arrays for empty input", () => {
    const { markets, errors } = parseMarketCreatedEvents([]);
    expect(markets).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("emits unknown_topic metric when encountering an unknown topic", () => {
    const telemetry: Telemetry = {
      record: vi.fn(),
      startSpan: vi.fn(() => ({ end: vi.fn() })),
    };
    const events = [
      makeEvent({
        id: "e1",
        topicsXdr: ["AAAADwAAABN1bmtub3duX2V2ZW50X3RvcGljIQ=="], // unknown topic
      }),
      makeEvent({ id: "e2" }),
    ];
    const { markets, errors } = parseMarketCreatedEvents(events, {
      telemetry,
    });
    expect(markets).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(telemetry.record).toHaveBeenCalledWith(
      "indexer.parser.unknown_topics",
      1,
      expect.objectContaining({
        parser: "market_created",
        eventId: "e1",
        contractId: "CMARKET",
        ledger: "555",
      })
    );
  });
});
