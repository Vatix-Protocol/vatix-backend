import { ValidationError } from '../api/middleware/errors.js';
import { getPrismaClient } from '../services/prisma.js';
import type { OrderSide, Outcome } from '../types/index.js';

// Input type for order validation (what the API receives)
export interface OrderInput {
  marketId: string;
  userAddress: string;
  side: OrderSide;
  outcome: Outcome;
  price: number;
  quantity: number;
}

// Validation result structure
export interface ValidationResult {
  valid: boolean;
  errors: Record<string, string>;
}

// Custom error type for order validation
export class OrderValidationError extends ValidationError {
  constructor(errors: Record<string, string>) {
    const message = Object.values(errors).join('; ');
    super(message, errors);
    this.name = 'OrderValidationError';
  }
}

/**
 * Validates a Stellar user address format
 * - Must be exactly 56 characters
 * - Must start with 'G' (Stellar public key prefix)
 */
export function validateUserAddress(address: string): string | null {
  if (typeof address !== 'string') {
    return 'User address must be a string';
  }

  if (address.length === 0) {
    return 'User address is required';
  }

  if (address.length !== 56) {
    return 'User address must be exactly 56 characters';
  }

  if (!address.startsWith('G')) {
    return 'User address must start with G';
  }

  return null;
}

/**
 * Validates order side
 * - Must be 'BUY' or 'SELL'
 */
export function validateOrderSide(side: unknown): string | null {
  if (side === null || side === undefined) {
    return 'Order side is required';
  }

  if (side !== 'BUY' && side !== 'SELL') {
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
    return 'Outcome is required';
  }

  if (outcome !== 'YES' && outcome !== 'NO') {
    return "Outcome must be 'YES' or 'NO'";
  }

  return null;
}

/**
 * Validates price
 * - Must be a number
 * - Must be > 0 and < 1 (exclusive range)
 */
export function validatePrice(price: unknown): string | null {
  if (price === null || price === undefined) {
    return 'Price is required';
  }

  if (typeof price !== 'number' || Number.isNaN(price)) {
    return 'Price must be a number';
  }

  if (price <= 0 || price >= 1) {
    return 'Price must be between 0 and 1 (exclusive)';
  }

  return null;
}

/**
 * Validates quantity
 * - Must be a positive integer
 */
export function validateQuantity(quantity: unknown): string | null {
  if (quantity === null || quantity === undefined) {
    return 'Quantity is required';
  }

  if (typeof quantity !== 'number' || Number.isNaN(quantity)) {
    return 'Quantity must be a number';
  }

  if (!Number.isInteger(quantity)) {
    return 'Quantity must be an integer';
  }

  if (quantity <= 0) {
    return 'Quantity must be positive';
  }

  return null;
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

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * Validates market state from database
 * - Market must exist
 * - Market status must be 'ACTIVE'
 * - Market endTime must be in the future
 */
export async function validateMarketState(marketId: string): Promise<ValidationResult> {
  const errors: Record<string, string> = {};
  const prisma = getPrismaClient();

  const market = await prisma.market.findUnique({
    where: { id: marketId },
  });

  if (!market) {
    errors.marketId = 'Market not found';
    return { valid: false, errors };
  }

  if (market.status !== 'ACTIVE') {
    errors.marketId = `Market is ${market.status.toLowerCase()}, orders cannot be placed`;
  }

  if (market.endTime <= new Date()) {
    errors.marketId = errors.marketId
      ? `${errors.marketId}; market has ended`
      : 'Market has ended';
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
export async function validateOrder(order: OrderInput): Promise<ValidationResult> {
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
