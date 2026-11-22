import { StrKey } from "@stellar/stellar-sdk";
import { ValidationError } from "../api/middleware/errors.js";
import { getPrismaClient } from "../services/prisma.js";
import type { OrderSide, Outcome } from "../types/index.js";
import {
  isTradable,
  type MarketLifecycleState,
} from "../../packages/shared/src/marketLifecycle.js";

/**
 * Maximum slippage fraction applied to a market order's `limitPrice` when the
 * caller supplies a `limitPrice` but omits `maxSlippagePct`.  Expressed as a
 * fraction in [0, 1] (0.1 = 10 %).
 *
 * The resulting worst-case price is inclusive: a BUY may execute at up to
 * `limitPrice * (1 + MAX_SLIPPAGE)` and a SELL down to
 * `limitPrice * (1 - MAX_SLIPPAGE)`; a fill exactly on that boundary is
 * allowed, anything beyond it is not.
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
  /**
   * Raw decimal text of `price` as supplied by the client (#1484). When
   * present and valid it is persisted verbatim instead of the lossy
   * `Number.prototype.toString()` rendering.
   */
  priceRaw?: string;
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

  // Length/prefix/charset checks above are fast rejects; the strkey decode
  // (base32 + CRC16-XModem checksum) is what proves the address is real.
  if (!isValidStellarPublicKey(address)) {
    return "User address must be a valid Stellar public key (G + 55 base32 chars)";
  }

  return null;
}

/**
 * True when `address` decodes as a Stellar account id strkey, including its
 * checksum. Never throws.
 */
export function isValidStellarPublicKey(address: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(address);
  } catch {
    return false;
  }
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
 * Smallest representable order price. Used as the floor for SELL worst-price
 * clamps so a 100 % slippage tolerance never yields a non-positive price.
 */
export const MIN_PRICE = 0.0001;

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
 * Normalizes an order price to the exact decimal string that must be stored
 * (#1484). `Number.prototype.toString()` is lossy for values such as 0.1
 * (it can yield "0.10000000000000001" after arithmetic), so the raw decimal
 * text supplied by the client is preferred whenever it is a valid tick-aligned
 * price. Otherwise the value is quantized to the 0.01 tick and rendered as a
 * plain decimal string (never exponential notation).
 *
 * @param price - A number already confirmed to be in [0, 1) and tick-aligned.
 * @param rawPrice - The raw decimal text from the request, if available.
 * @returns The decimal string to persist (e.g. "0.10").
 */
export function normalizePriceToDecimalString(
  price: number,
  rawPrice?: string | null
): string {
  if (typeof rawPrice === "string") {
    const trimmed = rawPrice.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (
        Number.isFinite(parsed) &&
        parsed === price &&
        (parsed === 0 || validateTickSize(parsed) === null)
      ) {
        return trimmed;
      }
    }
  }

  // Quantize to the tick using integer arithmetic, then render as a plain
  // decimal string with two fractional digits (scale 2).
  const ticks = Math.round(price / TICK_SIZE);
  const whole = Math.floor(ticks / 100);
  const fraction = ticks % 100;
  return `${whole}.${String(fraction).padStart(2, "0")}`;
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
 * Largest quantity the `Order.quantity` column can store.
 * `Order.quantity` is a Prisma `Int` (PostgreSQL `INTEGER`, 32-bit signed),
 * so the maximum storable value is 2^31 - 1 = 2147483647.
 */
export const MAX_ORDER_QUANTITY = 2_147_483_647;

/**
 * Validates quantity
 * - Must be a finite number
 * - Must be an integer (checked before the range check)
 * - Must be > 0 and <= MAX_ORDER_QUANTITY
 */
export function validateQuantity(quantity: unknown): string | null {
  if (quantity === null || quantity === undefined) {
    return "Quantity is required";
  }

  if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
    return "Quantity must be a number";
  }

  if (!Number.isInteger(quantity)) {
    return "Quantity must be an integer";
  }

  if (quantity <= 0) {
    return "Quantity must be positive";
  }

  if (quantity > MAX_ORDER_QUANTITY) {
    return `Quantity must be at most ${MAX_ORDER_QUANTITY}`;
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
 *
 * - No limitPrice: returns null (caller falls back to the book extremes).
 * - limitPrice without maxSlippagePct: the documented MAX_SLIPPAGE fraction is
 *   enforced, so the tolerance is never unbounded.
 * - Both supplied: maxSlippagePct (0–100 %) wins over MAX_SLIPPAGE.
 *
 * The returned bound is inclusive: a BUY may fill at exactly
 * `limitPrice * (1 + slippage)` and a SELL at exactly
 * `limitPrice * (1 - slippage)`.
 */
export function computeEffectiveWorstPrice(
  side: OrderSide,
  limitPrice?: number | null,
  maxSlippagePct?: number | null
): number | null {
  if (limitPrice === undefined || limitPrice === null) return null;

  const slippageFraction =
    maxSlippagePct === undefined || maxSlippagePct === null
      ? MAX_SLIPPAGE
      : maxSlippagePct / 100;

  const worstPrice =
    side === "BUY"
      ? limitPrice * (1 + slippageFraction)
      : limitPrice * (1 - slippageFraction);

  // Prices live in (0, 1); clamp so a wide tolerance cannot escape the range.
  return Math.min(Math.max(worstPrice, 0), 1);
}

/**
 * Validates all static (non-DB) fields of an order input and returns every
 * failure found, keyed by field name.
 *
 * `price === 0` is the market-order sentinel (see `OrderInput.price`) and is
 * exempt from the normal (0, 1) range check — but a market order with no
 * `limitPrice` has no bound at all, so that combination is rejected here,
 * in every environment (#1525), rather than left for the matching engine to
 * silently substitute a default worst-case price.
 */
export function validateOrderFields(input: OrderInput): ValidationResult {
  const errors: Record<string, string> = {};

  if (typeof input.marketId !== "string" || input.marketId.length === 0) {
    errors.marketId = "marketId is required";
  }

  const userAddressErr = validateUserAddress(input.userAddress);
  if (userAddressErr) errors.userAddress = userAddressErr;

  const sideErr = validateOrderSide(input.side);
  if (sideErr) errors.side = sideErr;

  const outcomeErr = validateOutcome(input.outcome);
  if (outcomeErr) errors.outcome = outcomeErr;

  if (input.price === 0) {
    // Market-order sentinel: skip the (0, 1) exclusive-range check that
    // would otherwise reject it.
  } else {
    const priceErr = validatePrice(input.price);
    if (priceErr) errors.price = priceErr;
  }

  const quantityErr = validateQuantity(input.quantity);
  if (quantityErr) errors.quantity = quantityErr;

  const limitPriceErr = validateLimitPrice(
    input.limitPrice,
    input.side,
    input.maxSlippagePct
  );
  if (limitPriceErr) errors.limitPrice = limitPriceErr;

  if (
    input.price === 0 &&
    input.limitPrice === undefined &&
    !errors.limitPrice
  ) {
    errors.limitPrice =
      "limitPrice is required for a market order (price 0) — no default worst-case price is substituted, in any environment";
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Validates that a market exists, is active, and has not ended.
 * Mirrors the checks `MatchingService.placeOrder` re-applies under its
 * per-book mutex (#792/#951) — this is the route-level pre-check referenced
 * there, run before the mutex wait so an obviously-bad market is rejected
 * without ever contending for the book lock.
 */
export async function validateMarketState(
  marketId: string
): Promise<ValidationResult> {
  const prisma = getPrismaClient();
  const market = await prisma.market.findUnique({ where: { id: marketId } });

  if (!market || market.deletedAt !== null) {
    return { valid: false, errors: { marketId: "Market not found" } };
  }

  if (market.status === "RESOLVED") {
    return {
      valid: false,
      errors: { marketId: "Market is resolved and no longer accepting orders" },
    };
  }

  if (market.status === "CANCELLED") {
    return {
      valid: false,
      errors: {
        marketId: "Market is cancelled and no longer accepting orders",
      },
    };
  }

  if (market.endTime.getTime() <= Date.now()) {
    return {
      valid: false,
      errors: {
        marketId: "Market has ended and is no longer accepting orders",
      },
    };
  }

  return { valid: true, errors: {} };
}

/**
 * Full order validation: static field checks first (no DB access — a
 * malformed payload never reaches Postgres), then market-state checks.
 */
export async function validateOrder(
  input: OrderInput
): Promise<ValidationResult> {
  const fieldResult = validateOrderFields(input);
  if (!fieldResult.valid) {
    return fieldResult;
  }

  return validateMarketState(input.marketId);
}

/**
 * Validates an order and throws `OrderValidationError` (carrying every
 * failing field on `.fields`) when invalid. Resolves with no value when the
 * order is valid.
 */
export async function assertValidOrder(input: OrderInput): Promise<void> {
  const result = await validateOrder(input);
  if (!result.valid) {
    throw new OrderValidationError(result.errors);
  }
}
