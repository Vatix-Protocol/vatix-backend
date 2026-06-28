import { describe, it, expect } from "vitest";
import { computeTradeHash, type TradeReceiptParams } from "./trade-receipt.js";

const BASE: TradeReceiptParams = {
  buyerAddress: "GABC1234567890123456789012345678901234567890123456789012",
  sellerAddress: "GDEF1234567890123456789012345678901234567890123456789012",
  marketId: "market-uuid-001",
  outcome: "YES",
  quantity: 100,
  price: 0.5,
  timestamp: 1700000000000,
};

describe("computeTradeHash", () => {
  it("returns a 64-char hex string", () => {
    const hash = computeTradeHash(BASE);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    expect(computeTradeHash(BASE)).toBe(computeTradeHash({ ...BASE }));
  });

  it("changes when buyerAddress changes", () => {
    const other = { ...BASE, buyerAddress: "GXXX" + "A".repeat(52) };
    expect(computeTradeHash(BASE)).not.toBe(computeTradeHash(other));
  });

  it("changes when sellerAddress changes", () => {
    const other = { ...BASE, sellerAddress: "GXXX" + "A".repeat(52) };
    expect(computeTradeHash(BASE)).not.toBe(computeTradeHash(other));
  });

  it("changes when marketId changes", () => {
    const other = { ...BASE, marketId: "market-uuid-002" };
    expect(computeTradeHash(BASE)).not.toBe(computeTradeHash(other));
  });

  it("changes when outcome changes", () => {
    const other = { ...BASE, outcome: "NO" };
    expect(computeTradeHash(BASE)).not.toBe(computeTradeHash(other));
  });

  it("changes when quantity changes", () => {
    const other = { ...BASE, quantity: 99 };
    expect(computeTradeHash(BASE)).not.toBe(computeTradeHash(other));
  });

  it("changes when price changes", () => {
    const other = { ...BASE, price: 0.6 };
    expect(computeTradeHash(BASE)).not.toBe(computeTradeHash(other));
  });

  it("changes when timestamp changes", () => {
    const other = { ...BASE, timestamp: 1700000000001 };
    expect(computeTradeHash(BASE)).not.toBe(computeTradeHash(other));
  });

  it("produces the same hash regardless of parameter insertion order", () => {
    const reordered: TradeReceiptParams = {
      timestamp: BASE.timestamp,
      price: BASE.price,
      quantity: BASE.quantity,
      outcome: BASE.outcome,
      marketId: BASE.marketId,
      sellerAddress: BASE.sellerAddress,
      buyerAddress: BASE.buyerAddress,
    };
    expect(computeTradeHash(BASE)).toBe(computeTradeHash(reordered));
  });
});
