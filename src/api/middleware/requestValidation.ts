import { z } from "zod";
import {
  TICK_SIZE,
  validateTickSize,
  STELLAR_PUBLIC_KEY_REGEX,
} from "../../matching/validation.js";

/**
 * Reusable Zod validation schemas for API requests
 */

export const stellarAddressSchema = z
  .string()
  .regex(
    STELLAR_PUBLIC_KEY_REGEX,
    "userAddress must be a valid Stellar address (public key)"
  );

export const orderPriceSchema = z
  .number()
  .gt(0, "price must be greater than 0")
  .lt(1, "price must be less than 1")
  .refine((val) => validateTickSize(val) === null, {
    message: `price must be a multiple of ${TICK_SIZE} (e.g. 0.01, 0.50, 0.99)`,
  });

export const orderQuantitySchema = z
  .number()
  .int("quantity must be an integer")
  .min(1, "quantity must be at least 1");

export const orderSideSchema = z.enum(["BUY", "SELL"]);

export const outcomeSchema = z.enum(["YES", "NO"]);

export const createOrderSchema = z.object({
  marketId: z.string().min(1, "marketId is required"),
  userAddress: stellarAddressSchema,
  side: orderSideSchema,
  outcome: outcomeSchema,
  price: orderPriceSchema,
  quantity: orderQuantitySchema,
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
