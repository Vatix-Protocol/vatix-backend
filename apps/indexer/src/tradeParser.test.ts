import { describe, it, expect } from "vitest";
import { parseTradeEvent, parseTradeEvents } from "./tradeParser.js";
import { TradeParseError } from "./types.js";
import type { RawChainEvent } from "./types.js";

// ─── Real XDR fixtures generated from @stellar/stellar-sdk ──────────────────

const XDR = {
  topic: {
    tradeExecuted: "AAAADwAAAA50cmFkZV9leGVjdXRlZAAA",
    marketCreated: "AAAADwAAAA5tYXJrZXRfY3JlYXRlZAAA",
  },
  value: {
    // direction=buy, outcome=YES, price=5_000_000, quantity=100
    validBuy:
      "AAAAEQAAAAEAAAAJAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC1hYmMAAAAAAA8AAAAGdHJhZGVyAAAAAAAPAAAACEdBQkMxMjM0AAAADwAAAAxjb3VudGVycGFydHkAAAAPAAAACEdYWVo1Njc4AAAADwAAAAlkaXJlY3Rpb24AAAAAAAAPAAAAA2J1eQAAAAAPAAAAB291dGNvbWUAAAAADwAAAANZRVMAAAAADwAAAAVwcmljZQAAAAAAAAoAAAAAAAAAAAAAAAAATEtAAAAADwAAAAhxdWFudGl0eQAAAAoAAAAAAAAAAAAAAAAAAABkAAAADwAAAAxidXlfb3JkZXJfaWQAAAAPAAAABWJ1eS0xAAAAAAAADwAAAA1zZWxsX29yZGVyX2lkAAAAAAAADwAAAAZzZWxsLTEAAA==",
    // direction=sell, outcome=YES
    validSell:
      "AAAAEQAAAAEAAAAJAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC1hYmMAAAAAAA8AAAAGdHJhZGVyAAAAAAAPAAAACEdBQkMxMjM0AAAADwAAAAxjb3VudGVycGFydHkAAAAPAAAACEdYWVo1Njc4AAAADwAAAAlkaXJlY3Rpb24AAAAAAAAPAAAABHNlbGwAAAAPAAAAB291dGNvbWUAAAAADwAAAANZRVMAAAAADwAAAAVwcmljZQAAAAAAAAoAAAAAAAAAAAAAAAAATEtAAAAADwAAAAhxdWFudGl0eQAAAAoAAAAAAAAAAAAAAAAAAABkAAAADwAAAAxidXlfb3JkZXJfaWQAAAAPAAAABWJ1eS0xAAAAAAAADwAAAA1zZWxsX29yZGVyX2lkAAAAAAAADwAAAAZzZWxsLTEAAA==",
    // direction=sell, outcome=NO
    sellNoOutcome:
      "AAAAEQAAAAEAAAAJAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC1hYmMAAAAAAA8AAAAGdHJhZGVyAAAAAAAPAAAACEdBQkMxMjM0AAAADwAAAAxjb3VudGVycGFydHkAAAAPAAAACEdYWVo1Njc4AAAADwAAAAlkaXJlY3Rpb24AAAAAAAAPAAAABHNlbGwAAAAPAAAAB291dGNvbWUAAAAADwAAAAJOTwAAAAAADwAAAAVwcmljZQAAAAAAAAoAAAAAAAAAAAAAAAAATEtAAAAADwAAAAhxdWFudGl0eQAAAAoAAAAAAAAAAAAAAAAAAABkAAAADwAAAAxidXlfb3JkZXJfaWQAAAAPAAAABWJ1eS0xAAAAAAAADwAAAA1zZWxsX29yZGVyX2lkAAAAAAAADwAAAAZzZWxsLTEAAA==",
    // price=9_999_999_999_999_999, quantity=1_000_000_000_000 (large i128)
    largeI128:
      "AAAAEQAAAAEAAAAJAAAADwAAAAltYXJrZXRfaWQAAAAAAAAPAAAACm1hcmtldC1hYmMAAAAAAA8AAAAGdHJhZGVyAAAAAAAPAAAACEdBQkMxMjM0AAAADwAAAAxjb3VudGVycGFydHkAAAAPAAAACEdYWVo1Njc4AAAADwAAAAlkaXJlY3Rpb24AAAAAAAAPAAAAA2J1eQAAAAAPAAAAB291dGNvbWUAAAAADwAAAANZRVMAAAAADwAAAAVwcmljZQAAAAAAAAoAAAAAAAAAAAAjhvJvwP//AAAADwAAAAhxdWFudGl0eQAAAAoAAAAAAAAAAAAAAOjUpRAAAAAADwAAAAxidXlfb3JkZXJfaWQAAAAPAAAABWJ1eS0xAAAAAAAADwAAAA1zZWxsX29yZGVyX2lkAAAAAAAADwAAAAZzZWxsLTEAAA==",
  },
};

function makeEvent(overrides: Partial<RawChainEvent> = {}): RawChainEvent {
  return {
    id: "evt-1",
    ledger: 42,
    ledgerClosedAt: "2024-06-01T12:00:00Z",
    contractId: "CTEST",
    type: "contract",
    pagingToken: "token-1",
    valueXdr: XDR.value.validBuy,
    topicsXdr: [XDR.topic.tradeExecuted],
    ...overrides,
  };
}

// ─── parseTradeEvent ─────────────────────────────────────────────────────────

describe("parseTradeEvent", () => {
  it("parses a buy event correctly", () => {
    const trade = parseTradeEvent(makeEvent());

    expect(trade.eventId).toBe("evt-1");
    expect(trade.ledger).toBe(42);
    expect(trade.marketId).toBe("market-abc");
    expect(trade.traderAddress).toBe("GABC1234");
    expect(trade.counterpartyAddress).toBe("GXYZ5678");
    expect(trade.direction).toBe("buy");
    expect(trade.outcome).toBe("YES");
    expect(trade.priceRaw).toBe(5_000_000n);
    expect(trade.quantityRaw).toBe(100n);
    expect(trade.buyOrderId).toBe("buy-1");
    expect(trade.sellOrderId).toBe("sell-1");
  });

  it("parses a sell event correctly", () => {
    const trade = parseTradeEvent(makeEvent({ valueXdr: XDR.value.validSell }));
    expect(trade.direction).toBe("sell");
    expect(trade.outcome).toBe("YES");
  });

  it("parses sell direction with NO outcome", () => {
    const trade = parseTradeEvent(
      makeEvent({ valueXdr: XDR.value.sellNoOutcome })
    );
    expect(trade.direction).toBe("sell");
    expect(trade.outcome).toBe("NO");
  });

  it("preserves large i128 values without precision loss", () => {
    const trade = parseTradeEvent(makeEvent({ valueXdr: XDR.value.largeI128 }));
    expect(trade.priceRaw).toBe(9_999_999_999_999_999n);
    expect(trade.quantityRaw).toBe(1_000_000_000_000n);
    // Confirm float conversion loses precision — bigint is the safe representation
    expect(Number(trade.priceRaw)).toBe(10_000_000_000_000_000); // rounded by float
  });

  it("carries ledger metadata through", () => {
    const trade = parseTradeEvent(
      makeEvent({
        ledger: 999,
        ledgerClosedAt: "2025-01-01T00:00:00Z",
        contractId: "CXYZ",
      })
    );
    expect(trade.ledger).toBe(999);
    expect(trade.ledgerClosedAt).toBe("2025-01-01T00:00:00Z");
    expect(trade.contractId).toBe("CXYZ");
  });

  it("throws TradeParseError when topic is not trade_executed", () => {
    expect(() =>
      parseTradeEvent(makeEvent({ topicsXdr: [XDR.topic.marketCreated] }))
    ).toThrow(TradeParseError);
  });

  it("throws TradeParseError when topicsXdr is empty", () => {
    expect(() => parseTradeEvent(makeEvent({ topicsXdr: [] }))).toThrow(
      TradeParseError
    );
  });

  it("throws TradeParseError on malformed value XDR", () => {
    expect(() =>
      parseTradeEvent(makeEvent({ valueXdr: "not-valid-xdr!!!!" }))
    ).toThrow(TradeParseError);
  });

  it("throws TradeParseError when a required field is missing", async () => {
    // Build a map XDR that is missing the 'quantity' field
    const { nativeToScVal, xdr } = await import("@stellar/stellar-sdk");
    const entries = [
      ["market_id", "market-abc"],
      ["trader", "GABC1234"],
      ["counterparty", "GXYZ5678"],
      ["direction", "buy"],
      ["outcome", "YES"],
      ["price", 5_000_000n],
      // quantity intentionally omitted
      ["buy_order_id", "buy-1"],
      ["sell_order_id", "sell-1"],
    ].map(
      ([k, v]) =>
        new xdr.ScMapEntry({
          key: nativeToScVal(k, { type: "symbol" }),
          val:
            typeof v === "bigint"
              ? nativeToScVal(v, { type: "i128" })
              : nativeToScVal(v, { type: "symbol" }),
        })
    );
    const missingQtyXdr = xdr.ScVal.scvMap(entries).toXDR("base64");

    expect(() =>
      parseTradeEvent(makeEvent({ valueXdr: missingQtyXdr }))
    ).toThrow(TradeParseError);
  });
});

// ─── parseTradeEvents (batch) ────────────────────────────────────────────────

describe("parseTradeEvents", () => {
  it("parses multiple valid events", () => {
    const events = [
      makeEvent({ id: "e1", valueXdr: XDR.value.validBuy }),
      makeEvent({ id: "e2", valueXdr: XDR.value.validSell }),
    ];
    const { trades, errors } = parseTradeEvents(events);
    expect(trades).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  it("silently skips non-trade events", () => {
    const events = [
      makeEvent({ id: "e1", topicsXdr: [XDR.topic.marketCreated] }),
      makeEvent({ id: "e2", valueXdr: XDR.value.validBuy }),
    ];
    const { trades, errors } = parseTradeEvents(events);
    expect(trades).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });

  it("collects errors without dropping other trades", () => {
    const events = [
      makeEvent({ id: "e1", valueXdr: XDR.value.validBuy }),
      makeEvent({ id: "e2", valueXdr: "bad-xdr" }),
      makeEvent({ id: "e3", valueXdr: XDR.value.validSell }),
    ];
    const { trades, errors } = parseTradeEvents(events);
    expect(trades).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TradeParseError);
    expect(errors[0].eventId).toBe("e2");
  });

  it("returns empty arrays for empty input", () => {
    const { trades, errors } = parseTradeEvents([]);
    expect(trades).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });
});
