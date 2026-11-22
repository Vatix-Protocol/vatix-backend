/**
 * Exact decimal price handling for the matching engine and replay tooling
 * (#1487).
 *
 * Prices are persisted as `Decimal(10, 8)` and must never be round-tripped
 * through `Number()`: a value such as `0.1 + 0.2` or `0.30000000000000004`
 * can compare differently as a float than as the decimal the ledger stored,
 * which silently changes which orders cross during a replay.
 *
 * The canonical in-memory representation is an integer number of ticks at a
 * fixed scale (1e-8, matching the DB column). `parsePriceToTicks` is the only
 * place a decimal string becomes a number, and it does so exactly.
 */

/** Decimal places used by `Decimal(10, 8)` price columns. */
export const PRICE_SCALE = 8;

/** Number of ticks in one whole unit of price (1e8). */
export const TICKS_PER_UNIT = 100_000_000;

const DECIMAL_PATTERN = /^([+-])?(\d*)(?:\.(\d*))?$/;

/**
 * Parse a decimal price string (or a Prisma `Decimal`-like object exposing
 * `toString()`) into integer ticks at `PRICE_SCALE`.
 *
 * Throws on malformed input or on more precision than the scale can hold,
 * rather than silently rounding — a rounded price is exactly the class of
 * bug this helper exists to prevent.
 */
export function parsePriceToTicks(value: string | { toString(): string }): number {
  const raw = typeof value === "string" ? value : value.toString();
  const match = DECIMAL_PATTERN.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid decimal price: "${raw}"`);
  }

  const [, sign, whole = "", fraction = ""] = match;
  if (whole === "" && fraction === "") {
    throw new Error(`Invalid decimal price: "${raw}"`);
  }
  if (fraction.length > PRICE_SCALE) {
    throw new Error(
      `Price "${raw}" has more than ${PRICE_SCALE} decimal places`
    );
  }

  const paddedFraction = fraction.padEnd(PRICE_SCALE, "0");
  const ticks =
    Number(whole || "0") * TICKS_PER_UNIT + Number(paddedFraction || "0");

  if (!Number.isSafeInteger(ticks)) {
    throw new Error(`Price "${raw}" is out of range`);
  }

  return sign === "-" ? -ticks : ticks;
}

/** Render integer ticks back to a canonical decimal string. */
export function ticksToPriceString(ticks: number): string {
  const sign = ticks < 0 ? "-" : "";
  const abs = Math.abs(ticks);
  const whole = Math.floor(abs / TICKS_PER_UNIT);
  const fraction = String(abs % TICKS_PER_UNIT).padStart(PRICE_SCALE, "0");
  return `${sign}${whole}.${fraction}`;
}

/**
 * Price comparison used by `matchOrder` (see `canMatch` in engine.ts), done
 * on integer ticks so it is exact.
 *
 * BUY takers cross when the maker price is at or below the taker price;
 * SELL takers cross when the maker price is at or above it.
 */
export function canMatchTicks(
  takerPriceTicks: number,
  makerPriceTicks: number,
  takerSide: "BUY" | "SELL"
): boolean {
  return takerSide === "BUY"
    ? makerPriceTicks <= takerPriceTicks
    : makerPriceTicks >= takerPriceTicks;
}
