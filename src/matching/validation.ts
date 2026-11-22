import { ValidationError } from "../api/middleware/errors.js";
import { getPrismaClient } from "../services/prisma.js";
import type { OrderSide, Outcome } from "../types/index.js";
import {
  isTradable,
  type MarketLifecycleState,
} from "../../packages/shared/src/marketLifecycle.js";

/**
 * Maximum fraction of the order quantity that may be left unfilled when
 * `allowPartialFill` is false (i.e. the order must fully execute or be
 * rejected).  Expressed as a value in [0, 1].
 */
export const MAX_SLIPPAGE = 0.1; // 10 %

/**
 * For a market order the caller omits `price`; the engine executes against
 * whatever resting orders exist.  To bound worst-case cost the caller may
 * supply `limitPrice` (cap on execution price for BUY; floor for SELL) and/or
 * `maxSlippagePct` (0–100, percent of `limitPrice` allowed to slip).
 *
 * | Field              | Meaning                                              |
 * |--------------------|------------------------------------------------------|
 * | price              | Limit price in (0, 1), exclusive — 0 is rejected     |
 * | limitPrice         | Worst acceptable execution price (optional)          |
 * | maxSlippagePct     | Max % deviation from limitPrice (optional, 0–100)   |
 * | allowPartialFill   | When false, reject if full qty cannot be filled      |
 */
// Input type for order validation (what the API receives)
export interface OrderInput {
  marketId: string;
  userAddress: string;
  side: OrderSide;
  outcome: Outcome;
  price: number;
  quantity: number;
  /** Optional worst-case execution price for market orders (BUY cap / SELL floor). */
  limitPrice?: number;
  /** Optional max slippage tolerance in percent (0–100). Ignored when limitPrice is absent. */
  maxSlippagePct?: number;
  /** When false (default true) a market order that cannot be fully filled at or within
   *  the limit price is rejected with 422 rather than partially executed. */
  allowPartialFill?: boolean;
}

// Validation result structure
export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

// Custom error type for order validation
export class OrderValidationError extends ValidationError {
  constructor(errors: Record<string, string>) {
    const message = Object.values(errors).join("; ");
    super(message, errors);
    this.name = "OrderValidationError";
  }
}

/**
 * Validates a Stellar user address format
 * - Must be exactly 56 characters
 * - Must start with 'G' (Stellar public key prefix)
 * - Remaining characters must be Stellar StrKey base32 charset [A-Z2-7]
 */
export const STELLAR_PUBLIC_KEY_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Sanitizes a raw user address string before validation or DB use.
 *
 * Steps applied in order:
 *  1. Reject non-string values immediately (returns null — caller must check).
 *  2. Strip leading/trailing ASCII whitespace (prevents length-check bypass).
 *  3. Uppercase the result (Stellar keys are uppercase; prevents case-folding
 *     bypass and ensures consistent storage).
 *  4. Strip any ASCII control characters and null bytes that could be used for
 *     log injection or query confusion (U+0000–U+001F, U+007F).
 *
 * Returns the sanitized string, or null when the input type is invalid.
 * Callers should pass the return value to `validateUserAddress`.
 */
export function sanitizeUserAddress(address: unknown): string | null {
  if (typeof address !== "string") return null;
  return (
    address
      .trim()
      .toUpperCase()
      // Remove ASCII control characters (including null bytes, newlines, tabs)
      // that have no place in a Stellar base32 public key.
      .replace(/[\x00-\x1F\x7F]/g, "")
  );
}

export function validateUserAddress(address: string): string | null {
  if (typeof address !== "string") {
    return "User address must be a string";
  }

  if (address.length === 0) {
    return "User address is required";
  }

  if (address.length !== 56) {
    return "User address must be exactly 56 characters";
  }

  if (!address.startsWith("G")) {
    return "User address must start with G";
  }

  if (!STELLAR_PUBLIC_KEY_REGEX.test(address)) {
    return "User address must be a valid Stellar public key (G + 55 base32 chars)";
  }

  return null;
}

/**
 * Validates order side
 * - Must be 'BUY' or 'SELL'
 */
export function validateOrderSide(side: unknown): string | null {
  if (side === null || side === undefined) {
    return "Order side is required";
  }

  if (side !== "BUY" && side !== "SELL") {
    return "Order side must be 'BUY' or 'SELL'";
  }

  return null;
}

/**
 * Validates outcome
 * - Must be 'YES' or 'NO'
 */
export function validateOutcome(outcome: unknown): string | null {
  if (outcome === null || outcome === undefined) {
    return "Outcome is required";
  }

  if (outcome !== "YES" && outcome !== "NO") {
    return "Outcome must be 'YES' or 'NO'";
  }

  return null;
}

/**
 * Minimum tick size for order prices.
 * All prices must be exact multiples of this value (e.g. 0.01, 0.50, 0.99).
 */
export const TICK_SIZE = 0.01;

/**
 * Validates that a price aligns to the minimum tick size.
 * Uses rounded integer arithmetic to avoid IEEE-754 floating-point drift.
 *
 * @param price - A number already confirmed to be in (0, 1).
 */
export function validateTickSize(price: number): string | null {
  const ticks = Math.round(price / TICK_SIZE);
  if (Math.abs(ticks * TICK_SIZE - price) > 1e-9) {
    return `Price must be a multiple of ${TICK_SIZE} (e.g. 0.01, 0.50, 0.99)`;
  }
  return null;
}

/**
 * Validates price
 * - Must be a number
 * - Must be > 0 and < 1 (exclusive range), aligned to TICK_SIZE
 * - 0 is rejected; market orders are expressed via `limitPrice`, not `price`
 */
export function validatePrice(price: unknown): string | null {
  if (price === null || price === undefined) {
    return "Price is required";
  }

  if (typeof price !== "number" || Number.isNaN(price)) {
    return "Price must be a number";
  }

  if (price <= 0 || price >= 1) {
    return "Price must be between 0 and 1 (exclusive)";
  }

  return validateTickSize(price);
}

/**
 * Validates quantity
 * - Must be a positive integer
 */
export function validateQuantity(quantity: unknown): string | null {
  if (quantity === null || quantity === undefined) {
    return "Quantity is required";
  }

  if (typeof quantity !== "number" || Number.isNaN(quantity)) {
    return "Quantity must be a number";
  }

  if (!Number.isInteger(quantity)) {
    return "Quantity must be an integer";
  }

  if (quantity <= 0) {
    return "Quantity must be positive";
  }

  return null;
}

/**
 * Validates an optional limit price for market orders.
 * When supplied it must satisfy the same constraints as a regular limit price,
 * plus the side-specific bound: a BUY limit is a cap on the execution price and
 * must stay below 1 after slippage, while a SELL limit is a floor and must stay
 * above 0 after slippage.
 */
export function validateLimitPrice(
  limitPrice: unknown,
  side: OrderSide,
  maxSlippagePct?: unknown
): string | null {
  if (limitPrice === undefined || limitPrice === null) return null;

  if (typeof limitPrice !== "number" || Number.isNaN(limitPrice)) {
    return "limitPrice must be a number";
  }

  if (limitPrice <= 0 || limitPrice >= 1) {
    return "limitPrice must be between 0 and 1 (exclusive)";
  }

  const tickErr = validateTickSize(limitPrice);
  if (tickErr) return `limitPrice: ${tickErr}`;

  const slippageErr = validateMaxSlippagePct(maxSlippagePct);
  if (slippageErr) return slippageErr;

  const slippage =
    typeof maxSlippagePct === "number" && !Number.isNaN(maxSlippagePct)
      ? maxSlippagePct / 100
      : 0;

  if (side === "BUY") {
    // Worst-case execution price for a BUY is limitPrice * (1 + slippage).
    if (limitPrice * (1 + slippage) >= 1) {
      return "limitPrice must be below 1 after slippage for a BUY order";
    }
  } else if (side === "SELL") {
    // Worst-case execution price for a SELL is limitPrice * (1 - slippage).
    if (limitPrice * (1 - slippage) <= 0) {
      return "limitPrice must be above 0 after slippage for a SELL order";
    }
  } else {
    return "side must be 'BUY' or 'SELL'";
  }

  return null;
}

/**
 * Validates an optional maxSlippagePct (0–100 %, inclusive on both ends).
 * Only meaningful when a limitPrice is also provided; callers should warn
 * or ignore it otherwise.
 */
export function validateMaxSlippagePct(pct: unknown): string | null {
  if (pct === undefined || pct === null) return null;

  if (typeof pct !== "number" || Number.isNaN(pct)) {
    return "maxSlippagePct must be a number";
  }

  if (pct < 0 || pct > 100) {
    return "maxSlippagePct must be between 0 and 100";
  }

  return null;
}

/**
 * Compute the effective worst-case price for a market order given an optional
 * limitPrice and maxSlippagePct.

/* … truncated 4301 chars — edit only what you need near the top … */
