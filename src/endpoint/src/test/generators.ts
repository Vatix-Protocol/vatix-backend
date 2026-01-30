/**
 * Property-based test generators using fast-check
 */

import * as fc from "fast-check";
import { Order, Trade, Market } from "../types/models";
import { OrderRequest } from "../types/requests";

// Generator for valid order sides
export const orderSideArb = fc.constantFrom("buy", "sell") as fc.Arbitrary<
  "buy" | "sell"
>;

// Generator for valid order types
export const orderTypeArb = fc.constantFrom("limit", "market") as fc.Arbitrary<
  "limit" | "market"
>;

// Generator for valid order status
export const orderStatusArb = fc.constantFrom(
  "pending",
  "partial",
  "filled",
  "cancelled",
) as fc.Arbitrary<"pending" | "partial" | "filled" | "cancelled">;

// Generator for valid market status
export const marketStatusArb = fc.constantFrom(
  "active",
  "closed",
  "resolved",
) as fc.Arbitrary<"active" | "closed" | "resolved">;

// Generator for positive numbers (prices, quantities)
export const positiveNumberArb = fc.float({
  min: Math.fround(0.01),
  max: Math.fround(1000000),
  noNaN: true,
});

// Generator for market IDs
export const marketIdArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0);

// Generator for user addresses (simplified)
export const userAddressArb = fc
  .string({ minLength: 40, maxLength: 40 })
  .filter((s) => s.trim().length === 40);

// Generator for outcomes
export const outcomeArb = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => s.trim().length > 0);

// Generator for order IDs
export const orderIdArb = fc.uuid();

// Generator for OrderRequest
export const orderRequestArb: fc.Arbitrary<OrderRequest> = fc.record({
  marketId: marketIdArb,
  side: orderSideArb,
  outcome: outcomeArb,
  price: fc.option(positiveNumberArb),
  quantity: positiveNumberArb,
  userAddress: userAddressArb,
});

// Generator for Order
export const orderArb: fc.Arbitrary<Order> = fc.record({
  id: orderIdArb,
  marketId: marketIdArb,
  userAddress: userAddressArb,
  side: orderSideArb,
  outcome: outcomeArb,
  orderType: orderTypeArb,
  price: fc.option(positiveNumberArb),
  originalQuantity: positiveNumberArb,
  remainingQuantity: positiveNumberArb,
  status: orderStatusArb,
  createdAt: fc.date(),
  updatedAt: fc.date(),
});

// Generator for Trade
export const tradeArb: fc.Arbitrary<Trade> = fc.record({
  id: orderIdArb,
  buyOrderId: orderIdArb,
  sellOrderId: orderIdArb,
  price: positiveNumberArb,
  quantity: positiveNumberArb,
  timestamp: fc.date(),
  buyerAddress: userAddressArb,
  sellerAddress: userAddressArb,
});

// Generator for Market
export const marketArb: fc.Arbitrary<Market> = fc.record({
  id: marketIdArb,
  title: fc.string({ minLength: 1, maxLength: 100 }),
  outcomes: fc.array(outcomeArb, { minLength: 2, maxLength: 10 }),
  status: marketStatusArb,
  createdAt: fc.date(),
  resolvedAt: fc.option(fc.date()),
});

// Generator for arrays of orders (for order book testing)
export const orderArrayArb = fc.array(orderArb, {
  minLength: 0,
  maxLength: 100,
});

// Generator for invalid order requests (for validation testing)
export const invalidOrderRequestArb = fc.oneof(
  // Missing required fields
  fc.record({
    marketId: fc.constant(""),
    side: orderSideArb,
    outcome: outcomeArb,
    quantity: positiveNumberArb,
    userAddress: userAddressArb,
  }),
  // Invalid side
  fc.record({
    marketId: marketIdArb,
    side: fc.constant("invalid" as any),
    outcome: outcomeArb,
    quantity: positiveNumberArb,
    userAddress: userAddressArb,
  }),
  // Negative quantity
  fc.record({
    marketId: marketIdArb,
    side: orderSideArb,
    outcome: outcomeArb,
    quantity: fc.float({
      min: Math.fround(-1000),
      max: Math.fround(-0.01),
      noNaN: true,
    }),
    userAddress: userAddressArb,
  }),
  // Negative price
  fc.record({
    marketId: marketIdArb,
    side: orderSideArb,
    outcome: outcomeArb,
    price: fc.float({
      min: Math.fround(-1000),
      max: Math.fround(-0.01),
      noNaN: true,
    }),
    quantity: positiveNumberArb,
    userAddress: userAddressArb,
  }),
);
