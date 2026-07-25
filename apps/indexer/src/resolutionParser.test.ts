import { describe, it, expect } from "vitest";
import { nativeToScVal } from "@stellar/stellar-sdk";
import {
  parseResolutionEvent,
  parseResolutionEvents,
} from "./resolutionParser.js";
import { ResolutionParseError } from "./types.js";
import type { RawChainEvent } from "./types.js";

// ─── Real XDR fixtures ───────────────────────────────────────────────────────
//
// Soroban's #[contractevent] macro snake-cases the event struct name
// including its "Event" suffix, so MarketResolvedEvent publishes under
// "market_resolved_event" (contracts/market/src/events.rs), with
// topics: [market_resolved_event, market_id: u32] and
// value (ScvMap): { outcome: bool, resolved_at: u64 }.

const XDR = {
  topic: {
    marketResolvedEvent: "AAAADwAAABVtYXJrZXRfcmVzb2x2ZWRfZXZlbnQAAAA=",
    tradeExecuted: "AAAADwAAAA50cmFkZV9leGVjdXRlZAAA",
  },
  marketId: {
    42: "AAAAAwAAACo=",
    7: "AAAAAwAAAAc=",
  },
  value: {
    // outcome=true, resolved_at=1700000000 (real on-chain shape)
    realYes:
      "AAAAEQAAAAEAAAACAAAADwAAAAdvdXRjb21lAAAAAAAAAAABAAAADwAAAAtyZXNvbHZlZF9hdAAAAAAFAAAAAGVT8QA=",
    // outcome=false, resolved_at=1690000000
    realNo:
      "AAAAEQAAAAEAAAACAAAADwAAAAdvdXRjb21lAAAAAAAAAAAAAAAADwAAAAtyZXNvbHZlZF9hdAAAAAAFAAAAAGS7WoA=",
    // legacy ScvMap: market_id=market-xyz, outcome=YES, oracle=GORACLE123
    resolvedYes:
      "AAAAEQAAAAEAAAADAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC14eXoAAAAAAA8AAAAHb3V0Y29tZQAAAAAPAAAAA1lFUwAAAAAPAAAABm9yYWNsZQAAAAAADwAAAApHT1JBQ0xFMTIzAAA=",
    // legacy ScvMap: outcome=NO
    resolvedNo:
      "AAAAEQAAAAEAAAADAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC14eXoAAAAAAA8AAAAHb3V0Y29tZQAAAAAPAAAAAk5PAAAAAAAPAAAABm9yYWNsZQAAAAAADwAAAApHT1JBQ0xFMTIzAAA=",
    // legacy ScvMap: outcome=MAYBE (unknown)
    unknownOutcome:
      "AAAAEQAAAAEAAAADAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC14eXoAAAAAAA8AAAAHb3V0Y29tZQAAAAAPAAAABU1BWUJFAAAAAAAADwAAAAZvcmFjbGUAAAAAAA8AAAAKR09SQUNMRTEyMwAA",
    // legacy ScvMap: oracle field omitted
    missingOracle:
      "AAAAEQAAAAEAAAACAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC14eXoAAAAAAA8AAAAHb3V0Y29tZQAAAAAPAAAAA1lFUwA=",
  },
};

function makeEvent(overrides: Partial<RawChainEvent> = {}): RawChainEvent {
  return {
    id: "evt-res-1",
    ledger: 100,
    ledgerClosedAt: "2024-09-01T00:00:00Z",
    contractId: "CRESOLUTION",
    type: "contract",
    pagingToken: "token-res-1",
    valueXdr: XDR.value.realYes,
    topicsXdr: [XDR.topic.marketResolvedEvent, XDR.marketId[42]],
    ...overrides,
  };
}

// ─── parseResolutionEvent ────────────────────────────────────────────────────

describe("parseResolutionEvent", () => {
  it("parses the real on-chain shape: market_id from topic, outcome+resolved_at from value", () => {
    const r = parseResolutionEvent(makeEvent());

    expect(r.marketId).toBe("42");
    expect(r.outcome).toBe("YES");
    expect(r.oracleAddress).toBe("");
  });

  it("parses the real on-chain shape with NO outcome and a different market_id", () => {
    const r = parseResolutionEvent(
      makeEvent({
        topicsXdr: [XDR.topic.marketResolvedEvent, XDR.marketId[7]],
        valueXdr: XDR.value.realNo,
      })
    );
    expect(r.marketId).toBe("7");
    expect(r.outcome).toBe("NO");
  });

  it("throws ResolutionParseError when the market_id topic is missing", () => {
    expect(() =>
      parseResolutionEvent(
        makeEvent({ topicsXdr: [XDR.topic.marketResolvedEvent] })
      )
    ).toThrow(ResolutionParseError);
  });

  it("parses legacy on-chain tuple payload (market_id, outcome, resolved_at)", () => {
    const tupleXdr = nativeToScVal([42, true, 1_700_000_000n]).toXDR("base64");
    const r = parseResolutionEvent(
      makeEvent({
        valueXdr: tupleXdr,
        topicsXdr: [XDR.topic.marketResolvedEvent],
        id: "evt-tuple",
      })
    );

    expect(r.marketId).toBe("42");
    expect(r.outcome).toBe("YES");
    expect(r.oracleAddress).toBe("");
  });

  it("parses legacy tuple NO outcome as boolean false", () => {
    const tupleXdr = nativeToScVal([7, false, 99n]).toXDR("base64");
    const r = parseResolutionEvent(
      makeEvent({
        valueXdr: tupleXdr,
        topicsXdr: [XDR.topic.marketResolvedEvent],
      })
    );
    expect(r.outcome).toBe("NO");
  });

  it("parses a legacy ScvMap YES resolution correctly", () => {
    const r = parseResolutionEvent(
      makeEvent({
        valueXdr: XDR.value.resolvedYes,
        topicsXdr: [XDR.topic.marketResolvedEvent],
      })
    );

    expect(r.eventId).toBe("evt-res-1");
    expect(r.marketId).toBe("market-xyz");
    expect(r.outcome).toBe("YES");
    expect(r.oracleAddress).toBe("GORACLE123");
  });

  it("parses a legacy ScvMap NO resolution correctly", () => {
    const r = parseResolutionEvent(
      makeEvent({
        valueXdr: XDR.value.resolvedNo,
        topicsXdr: [XDR.topic.marketResolvedEvent],
      })
    );
    expect(r.outcome).toBe("NO");
    expect(r.marketId).toBe("market-xyz");
  });

  it("includes the source ledger sequence in the record", () => {
    const r = parseResolutionEvent(makeEvent({ ledger: 42_000 }));
    expect(r.ledger).toBe(42_000);
  });

  it("includes ledgerClosedAt and contractId in the record", () => {
    const r = parseResolutionEvent(
      makeEvent({ ledgerClosedAt: "2025-03-15T08:30:00Z", contractId: "CXYZ" })
    );
    expect(r.ledgerClosedAt).toBe("2025-03-15T08:30:00Z");
    expect(r.contractId).toBe("CXYZ");
  });

  it("throws ResolutionParseError for unknown outcome value (legacy ScvMap)", () => {
    expect(() =>
      parseResolutionEvent(
        makeEvent({
          valueXdr: XDR.value.unknownOutcome,
          topicsXdr: [XDR.topic.marketResolvedEvent],
        })
      )
    ).toThrow(ResolutionParseError);
  });

  it("unknown outcome error message names the bad value", () => {
    try {
      parseResolutionEvent(
        makeEvent({
          valueXdr: XDR.value.unknownOutcome,
          topicsXdr: [XDR.topic.marketResolvedEvent],
        })
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionParseError);
      expect((err as ResolutionParseError).message).toContain("MAYBE");
    }
  });

  it("throws ResolutionParseError when topic is not market_resolved_event", () => {
    expect(() =>
      parseResolutionEvent(makeEvent({ topicsXdr: [XDR.topic.tradeExecuted] }))
    ).toThrow(ResolutionParseError);
  });

  it("throws ResolutionParseError when topicsXdr is empty", () => {
    expect(() => parseResolutionEvent(makeEvent({ topicsXdr: [] }))).toThrow(
      ResolutionParseError
    );
  });

  it("throws ResolutionParseError on malformed value XDR", () => {
    expect(() =>
      parseResolutionEvent(makeEvent({ valueXdr: "not!!valid!!xdr" }))
    ).toThrow(ResolutionParseError);
  });

  it("throws ResolutionParseError when oracle field is missing (legacy ScvMap)", () => {
    expect(() =>
      parseResolutionEvent(
        makeEvent({
          valueXdr: XDR.value.missingOracle,
          topicsXdr: [XDR.topic.marketResolvedEvent],
        })
      )
    ).toThrow(ResolutionParseError);
  });

  it("error carries the eventId", () => {
    try {
      parseResolutionEvent(makeEvent({ id: "bad-evt", topicsXdr: [] }));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as ResolutionParseError).eventId).toBe("bad-evt");
    }
  });
});

// ─── parseResolutionEvents (batch) ──────────────────────────────────────────

describe("parseResolutionEvents", () => {
  it("parses multiple valid resolution events", () => {
    const events = [
      makeEvent({ id: "e1", valueXdr: XDR.value.realYes }),
      makeEvent({
        id: "e2",
        topicsXdr: [XDR.topic.marketResolvedEvent, XDR.marketId[7]],
        valueXdr: XDR.value.realNo,
      }),
    ];
    const { resolutions, errors } = parseResolutionEvents(events);
    expect(resolutions).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(resolutions[0].outcome).toBe("YES");
    expect(resolutions[1].outcome).toBe("NO");
  });

  it("silently skips non-resolution events", () => {
    const events = [
      makeEvent({ id: "e1", topicsXdr: [XDR.topic.tradeExecuted] }),
      makeEvent({ id: "e2" }),
    ];
    const { resolutions, errors } = parseResolutionEvents(events);
    expect(resolutions).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("collects errors without dropping other resolutions", () => {
    const events = [
      makeEvent({ id: "e1", valueXdr: XDR.value.realYes }),
      makeEvent({ id: "e2", topicsXdr: [XDR.topic.marketResolvedEvent] }),
      makeEvent({
        id: "e3",
        topicsXdr: [XDR.topic.marketResolvedEvent, XDR.marketId[7]],
        valueXdr: XDR.value.realNo,
      }),
    ];
    const { resolutions, errors } = parseResolutionEvents(events);
    expect(resolutions).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(ResolutionParseError);
    expect(errors[0].eventId).toBe("e2");
  });

  it("returns empty arrays for empty input", () => {
    const { resolutions, errors } = parseResolutionEvents([]);
    expect(resolutions).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
