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
 * | price              | Omitted (0) — signals this is a market order         |
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
 * - 0 is allowed as a market-order sentinel (no resting price)
 * - Otherwise must be > 0 and < 1 (exclusive range), aligned to TICK_SIZE
 */
export function validatePrice(price: unknown): string | null {
  if (price === null || price === undefined) {
    return "Price is required";
  }

  if (typeof price !== "number" || Number.isNaN(price)) {
    return "Price must be a number";
  }

  // 0 is the market-order sentinel — skip range/tick checks
  if (price === 0) return null;

  if (price < 0 || price >= 1) {
    return "Price must be 0 (market order) or between 0 and 1 (exclusive)";
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
 * When supplied it must satisfy the same constraints as a regular limit price.
 */
export function validateLimitPrice(
  limitPrice: unknown,
  side: OrderSide
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
 * limitPrice and maxSlippagePct.  Returns null when neither bound is set
 * (uncapped market order — production callers SHOULD always supply one).
 *
 * For BUY  the effective cap = limitPrice * (1 + maxSlippagePct / 100)
 * For SELL the effective floor = limitPrice * (1 - maxSlippagePct / 100)
 * Both are clamped to (0, 1) to remain in the valid price range.
 */
export function computeEffectiveWorstPrice(
  side: OrderSide,
  limitPrice: number | undefined,
  maxSlippagePct: number | undefined
): number | null {
  if (limitPrice === undefined) return null;

  const slipFraction = (maxSlippagePct ?? 0) / 100;

  if (side === "BUY") {
    return Math.min(0.9999, limitPrice * (1 + slipFraction));
  } else {
    return Math.max(0.0001, limitPrice * (1 - slipFraction));
  }
}

/**
 * Validates all synchronous order fields
 * Returns aggregated validation result with all errors
 */
export function validateOrderFields(order: OrderInput): ValidationResult {
  const errors: Record<string, string> = {};

  const userAddressError = validateUserAddress(order.userAddress);
  if (userAddressError) {
    errors.userAddress = userAddressError;
  }

  const sideError = validateOrderSide(order.side);
  if (sideError) {
    errors.side = sideError;
  }

  const outcomeError = validateOutcome(order.outcome);
  if (outcomeError) {
    errors.outcome = outcomeError;
  }

  const priceError = validatePrice(order.price);
  if (priceError) {
    errors.price = priceError;
  }

  const quantityError = validateQuantity(order.quantity);
  if (quantityError) {
    errors.quantity = quantityError;
  }

  // Validate optional market-order limit/slippage fields
  if (order.limitPrice !== undefined) {
    const limitErr = validateLimitPrice(order.limitPrice, order.side);
    if (limitErr) errors.limitPrice = limitErr;
  }

  if (order.maxSlippagePct !== undefined) {
    const slipErr = validateMaxSlippagePct(order.maxSlippagePct);
    if (slipErr) errors.maxSlippagePct = slipErr;
  }

  // In production, market orders (price == 0) without a limitPrice are hard-blocked.
  // In development / test they are allowed to keep the local dev loop frictionless.
  if (
    order.price === 0 &&
    order.limitPrice === undefined &&
    process.env.NODE_ENV === "production"
  ) {
    errors.limitPrice =
      "Market orders require a limitPrice in production to prevent draining thin books";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Validates market state from database
 * - Market must exist
 * - Market status must be tradable per the shared lifecycle matrix
 * - Market endTime must be in the future
 */
export async function validateMarketState(
  marketId: string
): Promise<ValidationResult> {
  const errors: Record<string, string> = {};
  const prisma = getPrismaClient();

  const market = await prisma.market.findUnique({
    where: { id: marketId },
  });

  if (!market || market.deletedAt !== null) {
    errors.marketId = "Market not found";
    return { valid: false, errors };
  }

  if (!isTradable(market.status as MarketLifecycleState)) {
    errors.marketId = `Market is ${market.status.toLowerCase()}, orders cannot be placed`;
  }

  if (market.endTime <= new Date()) {
    errors.marketId = errors.marketId
      ? `${errors.marketId}; market has ended`
      : "Market has ended";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Main validation function
 * - Runs synchronous field validations first (fast path)
 * - If field validations pass, runs market state validation
 * - Returns combined validation result
 */
export async function validateOrder(
  order: OrderInput
): Promise<ValidationResult> {
  // Run synchronous validations first (fast path)
  const fieldResult = validateOrderFields(order);

  if (!fieldResult.valid) {
    return fieldResult;
  }

  // Only run database validation if field validation passes
  const marketResult = await validateMarketState(order.marketId);

  return marketResult;
}

/**
 * Helper that throws OrderValidationError if validation fails
 * Returns void if order is valid
 */
export async function assertValidOrder(order: OrderInput): Promise<void> {
  const result = await validateOrder(order);

  if (!result.valid) {
    throw new OrderValidationError(result.errors);
  }
}
