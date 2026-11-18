import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validatePrice } from '../../src/matching/validation';

const router = Router();

const orderSchema = z.object({
  side: z.enum(['buy', 'sell']),
  price: z.number().gt(0).lt(1),
  quantity: z.number().positive(),
});

router.post('/orders', (req: Request, res: Response) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid order input' });
  }

  const { price } = parsed.data;
  const priceError = validatePrice(price);
  if (priceError) {
    return res.status(400).json({ error: priceError });
  }

  return res.status(201).json({ status: 'accepted', order: parsed.data });
});

export default router;
