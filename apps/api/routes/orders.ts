import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  MAX_ORDER_QUANTITY,
  validatePrice,
  validateQuantity,
} from '../../src/matching/validation';

const router = Router();

const orderSchema = z
  .object({
    side: z.enum(['buy', 'sell']),
    price: z.number().gte(0).lt(1),
    quantity: z
      .number()
      .finite()
      .int()
      .positive()
      .max(MAX_ORDER_QUANTITY),
    limitPrice: z.number().gt(0).lt(1).optional(),
    maxSlippagePct: z.number().gte(0).optional(),
  })
  .superRefine((order, ctx) => {
    if (order.price === 0) {
      if (order.limitPrice === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['limitPrice'],
          message: 'limitPrice is required for market orders (price 0)',
        });
      }
      return;
    }

    if (order.limitPrice !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['limitPrice'],
        message: 'limitPrice is only allowed for market orders (price 0)',
      });
    }
  });

router.post('/orders', (req: Request, res: Response) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid order input' });
  }

  const { price, quantity } = parsed.data;
  const priceError = validatePrice(price);
  if (priceError) {
    return res.status(400).json({ error: priceError });
  }

  const quantityError = validateQuantity(quantity);
  if (quantityError) {
    return res.status(400).json({ error: quantityError });
  }

  return res.status(201).json({ status: 'accepted', order: parsed.data });
});

export default router;
