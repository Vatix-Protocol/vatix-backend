import { Decimal } from "@prisma/client/runtime/client.js";
import type { OrderSide } from "../types/index.js";

/**
 * Collateral amounts are stored with 8 fractional digits (Decimal(20, 8)).
 * Shared with the expiry worker (`apps/workers/src/expiry/job.ts`) and
 * operator cancel (`matching-service.ts`) so both round releases the same
 * way.
 */
export const COLLATERAL_DECIMALS = 8;

/**
 * Collateral locked per unit of quantity for one side of a binary-outcome
 * order: a BUY locks `price` per unit, a SELL locks `1 - price` per unit
 * (the two outcomes of a prediction market always sum to 1). This is the
 * single source of truth for that rule (#1533) — expiry and operator cancel
 * previously duplicated it, one with `Decimal` and one with raw `Number`
 * arithmetic that could leave IEEE-754 residue in the released amount.
 *
 * Accepts a Prisma `Decimal`, a decimal string, or a `number`; always
 * returns a `Decimal` so callers never round-trip through a lossy float.
 */
export function collateralPerUnit(
  side: OrderSide,
  price: Decimal | string | number
): Decimal {
  const priceDecimal =
    price instanceof Decimal ? price : new Decimal(price.toString());
  return side === "BUY" ? priceDecimal : new Decimal(1).minus(priceDecimal);
}

/**
 * Collateral to release for `remainingQty` unfilled units of an order,
 * computed entirely in exact decimal arithmetic and rounded to
 * `COLLATERAL_DECIMALS` with half-up rounding (matching the
 * `lockedCollateral` column's scale). No intermediate value passes through
 * `Number`, so the result carries no binary floating-point residue.
 *
 * Example: BUY price 0.25, quantity 4 releases exactly 1.00; SELL price
 * 0.25, quantity 4 releases exactly 3.00.
 */
export function computeCollateralToRelease(
  side: OrderSide,
  price: Decimal | string | number,
  remainingQty: Decimal | string | number
): Decimal {
  const qtyDecimal =
    remainingQty instanceof Decimal
      ? remainingQty
      : new Decimal(remainingQty.toString());
  return collateralPerUnit(side, price)
    .times(qtyDecimal)
    .toDecimalPlaces(COLLATERAL_DECIMALS, Decimal.ROUND_HALF_UP);
}
