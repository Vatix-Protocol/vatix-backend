import { describe, it, expect } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import {
  amountRawToDecimal,
  decimalToAmountRaw,
  sharesRawToInt,
  COLLATERAL_SCALE,
} from "./decimalUtils.js";

/**
 * Deterministic PRNG (mulberry32) so the fuzz runs below explore a wide,
 * reproducible input space instead of relying on Math.random (flaky CI
 * reruns would explore different values than a local failure).
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBigintUpTo(rand: () => number, maxExclusive: bigint): bigint {
  // Build a random bigint by sampling digit-by-digit magnitude, biased
  // toward exploring the full range including near-boundary values.
  const bits = maxExclusive.toString(2).length;
  let value = 0n;
  for (let i = 0; i < bits; i++) {
    value = (value << 1n) | (rand() < 0.5 ? 0n : 1n);
  }
  return value % (maxExclusive + 1n);
}

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

// ─── #948: fuzz coverage ──────────────────────────────────────────────────────
//
// `vatix-contract/test-vectors/share-math.json` — the on-chain contract's
// own share-math fixtures — is not vendored into this repository (verified:
// no `vatix-contract` directory exists in this tree), so these utilities
// cannot be asserted against the contract's literal test vectors today.
// Instead we fuzz the documented invariants (round-trip losslessness, exact
// boundary behavior) across a wide, reproducible input space. If the
// contract fixtures become available, load `share-math.json` here directly
// alongside (not instead of) this fuzz coverage.

describe("decimalToAmountRaw (#948)", () => {
  it("is the exact inverse of amountRawToDecimal for a fixed seeded fuzz run", () => {
    const rand = mulberry32(0xc0ffee);
    const MAX_RAW = 9_999_999_999_990_000_000n;

    for (let i = 0; i < 500; i++) {
      const raw = randomBigintUpTo(rand, MAX_RAW);
      const decimal = amountRawToDecimal(raw);
      expect(decimalToAmountRaw(decimal)).toBe(raw);
    }
  });

  it("round-trips every explicit boundary value", () => {
    const boundaries = [
      0n,
      1n,
      9_999_999n,
      10_000_000n,
      9_999_999_999_990_000_000n, // MAX_RAW
    ];
    for (const raw of boundaries) {
      expect(decimalToAmountRaw(amountRawToDecimal(raw))).toBe(raw);
    }
  });

  it("throws RangeError when the decimal carries more than 7 fractional digits", () => {
    expect(() => decimalToAmountRaw("1.00000001")).toThrow(RangeError);
  });

  it("throws RangeError when the decimal exceeds the Decimal(20,8) range", () => {
    expect(() => decimalToAmountRaw("1000000000000")).toThrow(RangeError);
  });

  it("accepts plain numbers and Decimal instances, not just strings", () => {
    expect(decimalToAmountRaw(1)).toBe(10_000_000n);
    expect(decimalToAmountRaw(new Decimal("0.5"))).toBe(5_000_000n);
  });
});

describe("sharesRawToInt (#948)", () => {
  it("passes through whole share counts unscaled (shares are not fixed-point on-chain)", () => {
    expect(sharesRawToInt(100n)).toBe(100);
    expect(sharesRawToInt("100")).toBe(100);
    expect(sharesRawToInt(0n)).toBe(0);
  });

  it("round-trips a fixed seeded fuzz run across the safe-integer range", () => {
    const rand = mulberry32(0x5eed);
    const MAX = BigInt(Number.MAX_SAFE_INTEGER);

    for (let i = 0; i < 500; i++) {
      const raw = randomBigintUpTo(rand, MAX);
      expect(sharesRawToInt(raw)).toBe(Number(raw));
      expect(Number.isInteger(sharesRawToInt(raw))).toBe(true);
    }
  });

  it("accepts exactly Number.MAX_SAFE_INTEGER", () => {
    expect(sharesRawToInt(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  it("throws RangeError one past Number.MAX_SAFE_INTEGER instead of silently losing precision", () => {
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => sharesRawToInt(tooBig)).toThrow(RangeError);
    expect(() => sharesRawToInt(tooBig)).toThrow(
      "exceeds Number.MAX_SAFE_INTEGER"
    );
  });

  it("throws RangeError for negative quantities", () => {
    expect(() => sharesRawToInt(-1n)).toThrow(RangeError);
    expect(() => sharesRawToInt("-5")).toThrow(RangeError);
  });

  it("throws RangeError for non-integer strings", () => {
    expect(() => sharesRawToInt("1.5")).toThrow(RangeError);
    expect(() => sharesRawToInt("abc")).toThrow(RangeError);
    expect(() => sharesRawToInt("")).toThrow(RangeError);
  });
});
