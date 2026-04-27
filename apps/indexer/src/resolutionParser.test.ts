import { describe, it, expect } from "vitest";
import {
  parseResolutionEvent,
  parseResolutionEvents,
} from "./resolutionParser.js";
import { ResolutionParseError } from "./types.js";
import type { RawChainEvent } from "./types.js";

// ─── Real XDR fixtures ───────────────────────────────────────────────────────

const XDR = {
  topic: {
    marketResolved: "AAAADwAAAA9tYXJrZXRfcmVzb2x2ZWQA",
    tradeExecuted: "AAAADwAAAA50cmFkZV9leGVjdXRlZAAA",
  },
  value: {
    // market_id=market-xyz, outcome=YES, oracle=GORACLE123
    resolvedYes:
      "AAAAEQAAAAEAAAADAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC14eXoAAAAAAA8AAAAHb3V0Y29tZQAAAAAPAAAAA1lFUwAAAAAPAAAABm9yYWNsZQAAAAAADwAAAApHT1JBQ0xFMTIzAAA=",
    // outcome=NO
    resolvedNo:
      "AAAAEQAAAAEAAAADAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC14eXoAAAAAAA8AAAAHb3V0Y29tZQAAAAAPAAAAAk5PAAAAAAAPAAAABm9yYWNsZQAAAAAADwAAAApHT1JBQ0xFMTIzAAA=",
    // outcome=MAYBE (unknown)
    unknownOutcome:
      "AAAAEQAAAAEAAAADAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC14eXoAAAAAAA8AAAAHb3V0Y29tZQAAAAAPAAAABU1BWUJFAAAAAAAADwAAAAZvcmFjbGUAAAAAAA8AAAAKR09SQUNMRTEyMwAA",
    // oracle field omitted
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
    valueXdr: XDR.value.resolvedYes,
    topicsXdr: [XDR.topic.marketResolved],
    ...overrides,
  };
}

// ─── parseResolutionEvent ────────────────────────────────────────────────────

describe("parseResolutionEvent", () => {
  it("parses a YES resolution correctly", () => {
    const r = parseResolutionEvent(makeEvent());

    expect(r.eventId).toBe("evt-res-1");
    expect(r.marketId).toBe("market-xyz");
    expect(r.outcome).toBe("YES");
    expect(r.oracleAddress).toBe("GORACLE123");
  });

  it("parses a NO resolution correctly", () => {
    const r = parseResolutionEvent(
      makeEvent({ valueXdr: XDR.value.resolvedNo })
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

  it("links the record to the correct marketId", () => {
    const r = parseResolutionEvent(makeEvent());
    expect(r.marketId).toBe("market-xyz");
  });

  it("throws ResolutionParseError for unknown outcome value", () => {
    expect(() =>
      parseResolutionEvent(makeEvent({ valueXdr: XDR.value.unknownOutcome }))
    ).toThrow(ResolutionParseError);
  });

  it("unknown outcome error message names the bad value", () => {
    try {
      parseResolutionEvent(makeEvent({ valueXdr: XDR.value.unknownOutcome }));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ResolutionParseError);
      expect((err as ResolutionParseError).message).toContain("MAYBE");
    }
  });

  it("throws ResolutionParseError when topic is not market_resolved", () => {
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

  it("throws ResolutionParseError when oracle field is missing", () => {
    expect(() =>
      parseResolutionEvent(makeEvent({ valueXdr: XDR.value.missingOracle }))
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
      makeEvent({ id: "e1", valueXdr: XDR.value.resolvedYes }),
      makeEvent({ id: "e2", valueXdr: XDR.value.resolvedNo }),
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
      makeEvent({ id: "e1", valueXdr: XDR.value.resolvedYes }),
      makeEvent({ id: "e2", valueXdr: XDR.value.unknownOutcome }),
      makeEvent({ id: "e3", valueXdr: XDR.value.resolvedNo }),
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
