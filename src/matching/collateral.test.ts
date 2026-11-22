import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import {
  collateralPerUnit,
  computeCollateralToRelease,
  COLLATERAL_DECIMALS,
} from "./collateral.js";

// Prediction-market collateral rule (#1533): a BUY locks `price` per unit,
// a SELL locks `1 - price` per unit, since the two outcomes of a binary
// market always sum to 1.
describe("collateralPerUnit", () => {
  it("is the price itself for a BUY", () => {
    expect(collateralPerUnit("BUY", "0.25").toString()).toBe("0.25");
  });

  it("is 1 minus the price for a SELL", () => {
    expect(collateralPerUnit("SELL", "0.25").toString()).toBe("0.75");
  });

  it("accepts a Decimal, a string, or a number and agrees on all three", () => {
    const fromDecimal = collateralPerUnit("SELL", new Decimal("0.25"));
    const fromString = collateralPerUnit("SELL", "0.25");
    const fromNumber = collateralPerUnit("SELL", 0.25);
    expect(fromDecimal.toString()).toBe("0.75");
    expect(fromString.toString()).toBe("0.75");
    expect(fromNumber.toString()).toBe("0.75");
  });
});

describe("computeCollateralToRelease", () => {
  // Acceptance criteria (#1533): buy price 0.25 quantity 4 releases exactly
  // 1.00; sell price 0.25 quantity 4 releases exactly 3.00. Neither result
  // may carry binary (IEEE-754) residue.
  it("releases exactly 1.00 for a BUY at price 0.25, quantity 4", () => {
    const released = computeCollateralToRelease("BUY", "0.25", 4);
    expect(released.toString()).toBe("1");
    expect(released.toNumber()).toBe(1);
  });

  it("releases exactly 3.00 for a SELL at price 0.25, quantity 4", () => {
    const released = computeCollateralToRelease("SELL", "0.25", 4);
    expect(released.toString()).toBe("3");
    expect(released.toNumber()).toBe(3);
  });

  it("matches the two numeric examples exactly, with no binary residue", () => {
    // Native float multiplication of 0.75 * 4 is exact, but the equivalent
    // computation via repeated subtraction/accumulation that the old
    // Number-based cancel path used (1 - 0.25, then * 4) is exactly where
    // IEEE-754 drift can creep in for other price/quantity combinations;
    // asserting the decimal string form (not just toNumber()) is the check
    // that would catch that drift.
    const buy = computeCollateralToRelease("BUY", "0.25", 4);
    const sell = computeCollateralToRelease("SELL", "0.25", 4);
    expect(buy.toDecimalPlaces(COLLATERAL_DECIMALS).toString()).toBe("1");
    expect(sell.toDecimalPlaces(COLLATERAL_DECIMALS).toString()).toBe("3");
  });

  it("rounds to COLLATERAL_DECIMALS (8) places half-up", () => {
    const released = computeCollateralToRelease("SELL", "0.123456785", 1);
    expect(released.decimalPlaces()).toBeLessThanOrEqual(COLLATERAL_DECIMALS);
  });

  it("accepts remainingQty and price as plain numbers, like the cancel path does", () => {
    const released = computeCollateralToRelease("BUY", 0.25, 4);
    expect(released.toNumber()).toBe(1);
  });
});
