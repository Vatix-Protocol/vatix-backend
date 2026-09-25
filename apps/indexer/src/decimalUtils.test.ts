import { describe, it, expect, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/client.js";
import {
  amountRawToDecimal,
  decimalToAmountRaw,
  sharesRawToInt,
  COLLATERAL_SCALE,
  DECIMAL_UTILS_ERROR_CODES,
  DecimalUtilsError,
  DecimalValueOutOfRangeError,
  DecimalInvalidIntegerStringError,
  DecimalExcessFractionalDigitsError,
  DecimalNegativeQuantityError,
  DecimalQuantityExceedsSafeIntegerError,
  DecimalFeatureDisabledError,
} from "./decimalUtils.js";
import type { Telemetry } from "./telemetry.js";

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

  it("handles large i128 amount without precision loss", () => {
    const raw = 9_999_999_999_990_000_000n;
    const result = amountRawToDecimal(raw);
    expect(result.equals(new Decimal("999999999999.0000000"))).toBe(true);
  });

  it("handles large amount with fractional part", () => {
    const raw = 1_000_000_000_000_000_001n;
    const result = amountRawToDecimal(raw);
    expect(result.equals(new Decimal("100000000000.0000001"))).toBe(true);
  });

  it("round-trips: bigint → Decimal string → bigint", () => {
    const raw = 123_456_789_012_345_678n;
    const dec = amountRawToDecimal(raw);
    const [intStr, fracStr] = dec.toFixed(7).split(".");
    const reconstructed =
      BigInt(intStr) * 10_000_000n + BigInt(fracStr.padEnd(7, "0"));
    expect(reconstructed).toBe(raw);
  });

  it("preserves all 7 fractional digits for amounts not divisible by 10^7", () => {
    const raw = 12_345_678n;
    expect(amountRawToDecimal(raw).toFixed(7)).toBe("1.2345678");
  });

  it("zero-pads fractional part when less than 7 digits", () => {
    const raw = 100n;
    expect(amountRawToDecimal(raw).toFixed(7)).toBe("0.0000100");
  });

  it("throws DecimalValueOutOfRangeError with stable error code when value exceeds range", () => {
    const tooBig = 10_000_000_000_000_000_000n;
    let caught: unknown;
    try {
      amountRawToDecimal(tooBig);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DecimalValueOutOfRangeError);
    expect((caught as DecimalValueOutOfRangeError).code).toBe(
      DECIMAL_UTILS_ERROR_CODES.VALUE_OUT_OF_RANGE
    );
  });

  it("throws DecimalInvalidIntegerStringError for non-integer string", () => {
    expect(() => amountRawToDecimal("1.5")).toThrow(DecimalInvalidIntegerStringError);
    expect(() => amountRawToDecimal("abc")).toThrow(DecimalInvalidIntegerStringError);
    expect(() => amountRawToDecimal("")).toThrow(DecimalInvalidIntegerStringError);
  });

  it("passes correlation ID through errors", () => {
    const cid = "test-corr-id-123";
    try {
      amountRawToDecimal("invalid", { correlationId: cid });
    } catch (err) {
      expect(err).toBeInstanceOf(DecimalUtilsError);
      expect((err as DecimalUtilsError).correlationId).toBe(cid);
    }
  });

  it("records metrics via telemetry", () => {
    const records: Array<{ metric: string; value: number; tags?: Record<string, string> }> = [];
    const mockTelemetry: Telemetry = {
      record(metric, value, tags) {
        records.push({ metric, value, tags });
      },
      startSpan: () => ({ end: () => {} }),
    };

    amountRawToDecimal(10_000_000n, { telemetry: mockTelemetry, correlationId: "c1" });
    expect(records.length).toBeGreaterThan(0);
    expect(records.some((r) => r.metric.includes("success"))).toBe(true);
  });

  it("enforces feature flags (kill-switch)", () => {
    expect(() =>
      amountRawToDecimal(10_000_000n, {
        featureFlags: { amountRawToDecimal: false },
      })
    ).toThrow(DecimalFeatureDisabledError);
  });
});

describe("decimalToAmountRaw", () => {
  it("is the exact inverse of amountRawToDecimal for a fixed seeded fuzz run", () => {
    const rand = mulberry32(0xc0ffee);
    const MAX_RAW = 9_999_999_999_990_000_000n;

    for (let i = 0; i < 200; i++) {
      const raw = randomBigintUpTo(rand, MAX_RAW);
      const decimal = amountRawToDecimal(raw);
      expect(decimalToAmountRaw(decimal)).toBe(raw);
    }
  });

  it("throws DecimalExcessFractionalDigitsError when decimal carries > 7 fractional digits", () => {
    expect(() => decimalToAmountRaw("1.00000001")).toThrow(
      DecimalExcessFractionalDigitsError
    );
  });

  it("throws DecimalValueOutOfRangeError when decimal exceeds range", () => {
    expect(() => decimalToAmountRaw("1000000000000")).toThrow(
      DecimalValueOutOfRangeError
    );
  });

  it("accepts plain numbers and Decimal instances", () => {
    expect(decimalToAmountRaw(1)).toBe(10_000_000n);
    expect(decimalToAmountRaw(new Decimal("0.5"))).toBe(5_000_000n);
  });

  it("enforces feature flags for decimalToAmountRaw", () => {
    expect(() =>
      decimalToAmountRaw(1, { featureFlags: { decimalToAmountRaw: false } })
    ).toThrow(DecimalFeatureDisabledError);
  });
});

describe("sharesRawToInt", () => {
  it("passes through whole share counts unscaled", () => {
    expect(sharesRawToInt(100n)).toBe(100);
    expect(sharesRawToInt("100")).toBe(100);
    expect(sharesRawToInt(0n)).toBe(0);
  });

  it("throws DecimalNegativeQuantityError for negative quantities", () => {
    expect(() => sharesRawToInt(-1n)).toThrow(DecimalNegativeQuantityError);
    expect(() => sharesRawToInt("-5")).toThrow(DecimalNegativeQuantityError);
  });

  it("throws DecimalQuantityExceedsSafeIntegerError one past MAX_SAFE_INTEGER", () => {
    const tooBig = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => sharesRawToInt(tooBig)).toThrow(
      DecimalQuantityExceedsSafeIntegerError
    );
  });

  it("throws DecimalInvalidIntegerStringError for non-integer strings", () => {
    expect(() => sharesRawToInt("1.5")).toThrow(DecimalInvalidIntegerStringError);
  });

  it("enforces feature flags for sharesRawToInt", () => {
    expect(() =>
      sharesRawToInt(100n, { featureFlags: { sharesRawToInt: false } })
    ).toThrow(DecimalFeatureDisabledError);
  });
});
