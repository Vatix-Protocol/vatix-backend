import { describe, it, expect } from "vitest";
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  parseCollateralDepositedEvent,
  parseCollateralDepositedEvents,
} from "./collateralDepositedParser.js";
import { CollateralDepositedParseError } from "./types.js";
import type { RawChainEvent } from "./types.js";

// ─── Topic XDR fixtures ───────────────────────────────────────────────────────
// Symbol "collateral_deposited" encoded as ScvSymbol base64
const COLLATERAL_TOPIC = nativeToScVal("collateral_deposited", {
  type: "symbol",
}).toXDR("base64");
const TRADE_TOPIC = "AAAADwAAAA50cmFkZV9leGVjdXRlZAAA";

// ─── Value XDR helpers ────────────────────────────────────────────────────────

/** Contract emits: Vec [ account: ScvString, market_id: ScvU32, amount: ScvI128 ] */
function makeDepositValueXdr(
  account: string,
  marketId: number,
  amount: bigint
): string {
  return nativeToScVal([account, marketId, amount]).toXDR("base64");
}

function makeEvent(overrides: Partial<RawChainEvent> = {}): RawChainEvent {
  return {
    id: "0000000100-0000000001-0000000000",
    ledger: 100,
    ledgerClosedAt: "2024-10-01T00:00:00Z",
    contractId: "CDEPOSIT",
    type: "contract",
    pagingToken: "token-dep-1",
    valueXdr: makeDepositValueXdr("GACCOUNT1234", 7, 500_000_000n),
    topicsXdr: [COLLATERAL_TOPIC],
    ...overrides,
  };
}

// ─── parseCollateralDepositedEvent ───────────────────────────────────────────

describe("parseCollateralDepositedEvent", () => {
  it("parses tuple payload (account, market_id, amount)", () => {
    const d = parseCollateralDepositedEvent(makeEvent());
    expect(d.eventId).toBe("0000000100-0000000001-0000000000");
    expect(d.ledger).toBe(100);
    expect(d.contractId).toBe("CDEPOSIT");
    expect(d.account).toBe("GACCOUNT1234");
    expect(d.marketId).toBe("7");
    expect(d.amountRaw).toBe(500_000_000n);
  });

  it("handles large i128 amounts without precision loss", () => {
    const big = 9_999_999_999_999_999_999n;
    const d = parseCollateralDepositedEvent(
      makeEvent({ valueXdr: makeDepositValueXdr("GABC", 1, big) })
    );
    expect(d.amountRaw).toBe(big);
  });

  it("passes ledgerClosedAt through", () => {
    const d = parseCollateralDepositedEvent(
      makeEvent({ ledgerClosedAt: "2025-06-15T12:00:00Z" })
    );
    expect(d.ledgerClosedAt).toBe("2025-06-15T12:00:00Z");
  });

  it("throws CollateralDepositedParseError when topic does not match", () => {
    expect(() =>
      parseCollateralDepositedEvent(makeEvent({ topicsXdr: [TRADE_TOPIC] }))
    ).toThrow(CollateralDepositedParseError);
  });

  it("throws CollateralDepositedParseError when topicsXdr is empty", () => {
    expect(() =>
      parseCollateralDepositedEvent(makeEvent({ topicsXdr: [] }))
    ).toThrow(CollateralDepositedParseError);
  });

  it("throws CollateralDepositedParseError on malformed XDR", () => {
    expect(() =>
      parseCollateralDepositedEvent(makeEvent({ valueXdr: "not-xdr!!" }))
    ).toThrow(CollateralDepositedParseError);
  });

  it("throws CollateralDepositedParseError when payload is not a tuple", () => {
    // ScvMap instead of Vec
    const mapXdr = nativeToScVal({ market_id: 1, account: "G" }).toXDR(
      "base64"
    );
    expect(() =>
      parseCollateralDepositedEvent(makeEvent({ valueXdr: mapXdr }))
    ).toThrow(CollateralDepositedParseError);
  });

  it("throws CollateralDepositedParseError when tuple has fewer than 3 elements", () => {
    const shortXdr = nativeToScVal(["GABC", 1]).toXDR("base64");
    expect(() =>
      parseCollateralDepositedEvent(makeEvent({ valueXdr: shortXdr }))
    ).toThrow(CollateralDepositedParseError);
  });

  it("error carries the eventId", () => {
    try {
      parseCollateralDepositedEvent(
        makeEvent({ id: "bad-evt", topicsXdr: [] })
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as CollateralDepositedParseError).eventId).toBe("bad-evt");
    }
  });
});

// ─── parseCollateralDepositedEvents (batch) ──────────────────────────────────

describe("parseCollateralDepositedEvents", () => {
  it("parses multiple valid deposit events", () => {
    const events = [
      makeEvent({
        id: "0000000100-0000000001-0000000000",
        valueXdr: makeDepositValueXdr("GACC1", 1, 100n),
      }),
      makeEvent({
        id: "0000000101-0000000001-0000000000",
        valueXdr: makeDepositValueXdr("GACC2", 2, 200n),
      }),
    ];
    const { deposits, errors } = parseCollateralDepositedEvents(events);
    expect(deposits).toHaveLength(2);
    expect(errors).toHaveLength(0);
    expect(deposits[0].amountRaw).toBe(100n);
    expect(deposits[1].amountRaw).toBe(200n);
  });

  it("silently skips non-collateral-deposited events", () => {
    const events = [
      makeEvent({ id: "e1", topicsXdr: [TRADE_TOPIC] }),
      makeEvent({ id: "e2" }),
    ];
    const { deposits, errors } = parseCollateralDepositedEvents(events);
    expect(deposits).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("collects errors without dropping valid deposits", () => {
    const events = [
      makeEvent({
        id: "0000000100-0000000001-0000000000",
        valueXdr: makeDepositValueXdr("GACC1", 1, 100n),
      }),
      makeEvent({
        id: "0000000101-0000000001-0000000000",
        valueXdr: "bad-xdr",
      }),
      makeEvent({
        id: "0000000102-0000000001-0000000000",
        valueXdr: makeDepositValueXdr("GACC3", 3, 300n),
      }),
    ];
    const { deposits, errors } = parseCollateralDepositedEvents(events);
    expect(deposits).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(CollateralDepositedParseError);
    expect(errors[0].eventId).toBe("0000000101-0000000001-0000000000");
  });

  it("returns empty arrays for empty input", () => {
    const { deposits, errors } = parseCollateralDepositedEvents([]);
    expect(deposits).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
