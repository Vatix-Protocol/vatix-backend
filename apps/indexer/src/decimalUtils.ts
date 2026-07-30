import { Decimal } from "@prisma/client/runtime/library.js";

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
