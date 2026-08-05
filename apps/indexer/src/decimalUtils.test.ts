import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import { amountRawToDecimal, COLLATERAL_SCALE } from "./decimalUtils.js";

describe("amountRawToDecimal", () => {
  it("COLLATERAL_SCALE is 7", () => {
    expect(COLLATERAL_SCALE).toBe(7n);
  });

  // ── Round-trip fixtures ────────────────────────────────────────────────────

  it("converts 0 to Decimal('0.0000000')", () => {
    expect(amountRawToDecimal(0n).equals(new Decimal("0.0000000"))).toBe(true);
  });

  it("converts 10_000_000n to Decimal('1.0000000')", () => {
    expect(
      amountRawToDecimal(10_000_000n).equals(new Decimal("1.0000000"))
    ).toBe(true);
  });

  it("converts 5_000_000n to Decimal('0.5000000')", () => {
    expect(
      amountRawToDecimal(5_000_000n).equals(new Decimal("0.5000000"))
    ).toBe(true);
  });

  it("converts 1n to Decimal('0.0000001') — smallest unit", () => {
    expect(amountRawToDecimal(1n).equals(new Decimal("0.0000001"))).toBe(true);
  });

  it("converts 500_000_000n to Decimal('50.0000000')", () => {
    expect(
      amountRawToDecimal(500_000_000n).equals(new Decimal("50.0000000"))
    ).toBe(true);
  });

  it("accepts string representation and produces same result as bigint", () => {
    expect(
      amountRawToDecimal("10000000").equals(amountRawToDecimal(10_000_000n))
    ).toBe(true);
  });

  // ── Large i128 amounts — no precision loss ─────────────────────────────────

  it("handles large i128 amount without precision loss", () => {
    // 9_999_999_999_990_000_000 raw == 999_999_999_999.0000000
    const raw = 9_999_999_999_990_000_000n;
    const result = amountRawToDecimal(raw);
    expect(result.equals(new Decimal("999999999999.0000000"))).toBe(true);
  });

  it("handles large amount with fractional part", () => {
    // 1_000_000_000_000_000_001n == 100_000_000_000.0000001
    const raw = 1_000_000_000_000_000_001n;
    const result = amountRawToDecimal(raw);
    expect(result.equals(new Decimal("100000000000.0000001"))).toBe(true);
  });

  it("round-trips: bigint → Decimal string → bigint", () => {
    const raw = 123_456_789_012_345_678n;
    const dec = amountRawToDecimal(raw);
    // Reconstruct raw from decimal string: multiply integer and fractional parts
    const [intStr, fracStr] = dec.toFixed(7).split(".");
    const reconstructed =
      BigInt(intStr) * 10_000_000n + BigInt(fracStr.padEnd(7, "0"));
    expect(reconstructed).toBe(raw);
  });

  // ── Fractional amounts ─────────────────────────────────────────────────────

  it("preserves all 7 fractional digits for amounts not divisible by 10^7", () => {
    const raw = 12_345_678n; // 1.2345678
    expect(amountRawToDecimal(raw).toFixed(7)).toBe("1.2345678");
  });

  it("zero-pads fractional part when less than 7 digits", () => {
    const raw = 100n; // 0.0000100
    expect(amountRawToDecimal(raw).toFixed(7)).toBe("0.0000100");
  });

  // ── Overflow / invalid rejected ────────────────────────────────────────────

  it("throws RangeError when value exceeds Decimal(20,8) column range", () => {
    const tooBig = 10_000_000_000_000_000_000n; // > MAX_RAW
    expect(() => amountRawToDecimal(tooBig)).toThrow(RangeError);
    expect(() => amountRawToDecimal(tooBig)).toThrow("exceeds Decimal(20,8)");
  });

  it("throws RangeError for non-integer string", () => {
    expect(() => amountRawToDecimal("1.5")).toThrow(RangeError);
    expect(() => amountRawToDecimal("abc")).toThrow(RangeError);
    expect(() => amountRawToDecimal("")).toThrow(RangeError);
  });

  it("throws RangeError for string with spaces around non-integer content", () => {
    expect(() => amountRawToDecimal("1 000")).toThrow(RangeError);
  });

  it("accepts string with leading/trailing whitespace if otherwise valid integer", () => {
    expect(
      amountRawToDecimal(" 10000000 ").equals(new Decimal("1.0000000"))
    ).toBe(true);
  });
});
