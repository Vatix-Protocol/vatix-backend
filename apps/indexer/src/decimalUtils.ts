import { Decimal } from "@prisma/client/runtime/client.js";

/**
 * On-chain collateral amounts are i128 integers with 7 implicit decimal places.
 * e.g. 10_000_000n on-chain == 1.0 collateral unit.
 *
 * This scale matches the `Decimal(20, 8)` columns in the Prisma schema
 * (lockedCollateral, collateralReleased) which store up to 8 fractional digits —
 * more than enough for the 7-decimal on-chain representation.
 */
export const COLLATERAL_SCALE = 7n;
const COLLATERAL_DIVISOR = 10n ** COLLATERAL_SCALE; // 10_000_000n

/**
 * Convert a raw on-chain collateral amount (i128 integer, 7 implicit decimals)
 * to a Prisma Decimal suitable for DB columns typed Decimal(20, 8).
 *
 * @param raw - bigint or decimal-string representation of the i128 amount
 * @throws RangeError when raw is not a finite integer string / bigint,
 *         or when the value exceeds the Decimal(20, 8) column range.
 *
 * @example
 *   amountRawToDecimal(10_000_000n)  // => Decimal("1.0000000")
 *   amountRawToDecimal("500000000")  // => Decimal("50.0000000")
 */
export function amountRawToDecimal(raw: bigint | string): Decimal {
  let value: bigint;

  if (typeof raw === "bigint") {
    value = raw;
  } else {
    if (!/^-?\d+$/.test(raw.trim())) {
      throw new RangeError(
        `amountRawToDecimal: invalid integer string "${raw}"`
      );
    }
    value = BigInt(raw.trim());
  }

  // Decimal(20, 8): max 12 integer digits + 8 fractional = 20 total.
  // The largest representable value is 999_999_999_999.99999999
  // In raw units (7 decimals): 999_999_999_999 * 10^7 = 9_999_999_999_990_000_000
  const MAX_RAW = 9_999_999_999_990_000_000n;
  const absValue = value < 0n ? -value : value;
  if (absValue > MAX_RAW) {
    throw new RangeError(
      `amountRawToDecimal: value ${value} exceeds Decimal(20,8) column range`
    );
  }

  // Perform integer division and remainder to build the decimal string
  // without floating-point loss.
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const intPart = abs / COLLATERAL_DIVISOR;
  const fracPart = abs % COLLATERAL_DIVISOR;
  // Zero-pad fractional part to COLLATERAL_SCALE digits
  const fracStr = fracPart.toString().padStart(Number(COLLATERAL_SCALE), "0");

  return new Decimal(`${sign}${intPart}.${fracStr}`);
}

/**
 * Inverse of `amountRawToDecimal`: convert a Decimal(20,8) collateral value
 * back into its raw on-chain i128 representation (bigint, 7 implicit
 * decimals). Needed anywhere a DB/API decimal amount must round-trip back
 * onto the chain (e.g. building a contract call from a stored value).
 *
 * @throws RangeError when value carries more than 7 fractional digits
 *         (would silently truncate on-chain) or falls outside the
 *         Decimal(20,8) column range.
 */
export function decimalToAmountRaw(value: Decimal | string | number): bigint {
  const decimal = value instanceof Decimal ? value : new Decimal(value);
  const scaled = decimal.mul(COLLATERAL_DIVISOR.toString());

  if (!scaled.isInteger()) {
    throw new RangeError(
      `decimalToAmountRaw: value ${decimal.toString()} has more than ${COLLATERAL_SCALE} fractional digits`
    );
  }

  const raw = BigInt(scaled.toFixed(0));
  const absRaw = raw < 0n ? -raw : raw;
  const MAX_RAW = 9_999_999_999_990_000_000n;
  if (absRaw > MAX_RAW) {
    throw new RangeError(
      `decimalToAmountRaw: value ${decimal.toString()} exceeds Decimal(20,8) column range`
    );
  }

  return raw;
}

/**
 * Largest bigint that survives a bigint -> Number conversion without
 * silent precision loss (`Number.MAX_SAFE_INTEGER`).
 */
const MAX_SAFE_SHARE_QUANTITY = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Convert a raw on-chain trade/order quantity into a validated JS integer
 * share count (#948).
 *
 * Unlike collateral and price, on-chain share quantities are **not**
 * fixed-point scaled — a prediction-market share is a discrete, whole unit,
 * matching the plain-integer `quantity` used throughout the CLOB
 * (`src/matching`) and the `Int` `yesShares`/`noShares` columns on
 * `UserPosition`. So this performs no division — its job is to make the
 * bigint -> Number boundary explicit and safe instead of an unchecked
 * `Number(raw)`, which silently loses precision past
 * `Number.MAX_SAFE_INTEGER` and silently accepts negative/fractional input.
 *
 * NOTE: `vatix-contract/test-vectors/share-math.json` (the on-chain
 * contract's own share-math fixtures) is not vendored into this repository,
 * so this conversion is verified here by property/round-trip fuzzing over
 * the documented invariants rather than against the contract's own
 * fixtures. If/when that file becomes available, wire it into
 * `decimalUtils.test.ts` directly.
 *
 * @throws RangeError if raw is negative, not a whole integer, or exceeds
 *         Number.MAX_SAFE_INTEGER.
 */
export function sharesRawToInt(raw: bigint | string): number {
  let value: bigint;

  if (typeof raw === "bigint") {
    value = raw;
  } else {
    if (!/^-?\d+$/.test(raw.trim())) {
      throw new RangeError(`sharesRawToInt: invalid integer string "${raw}"`);
    }
    value = BigInt(raw.trim());
  }

  if (value < 0n) {
    throw new RangeError(
      `sharesRawToInt: quantity must not be negative, got ${value}`
    );
  }

  if (value > MAX_SAFE_SHARE_QUANTITY) {
    throw new RangeError(
      `sharesRawToInt: quantity ${value} exceeds Number.MAX_SAFE_INTEGER (${MAX_SAFE_SHARE_QUANTITY}) and cannot be converted without precision loss`
    );
  }

  return Number(value);
}
