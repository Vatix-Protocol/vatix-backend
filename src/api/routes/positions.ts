import { Router, Request, Response, NextFunction } from 'express';
import { getPrismaClient } from '../../services/prisma';
import { AppError } from '../middleware/errors';

const router = Router();

/**
 * GET /positions/user/:address
 * Retrieves all market positions for a specific user.
 */
router.get('/user/:address', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { address } = req.params;
    const prisma = getPrismaClient();

    // Basic Address Validation (Hex check)
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      throw new AppError(400, 'Invalid address format');
    }

    // Query positions with market join
    const positions = await prisma.position.findMany({
      where: { userAddress: address },
      include: {
        market: true,
      },
    });

    // Calculate potential payout
    const results = positions.map((p) => ({
      ...p,
      potentialPayout: Math.max(Number(p.yesShares), Number(p.noShares)),
    }));

    return res.status(200).json(results);
  } catch (error) {
    next(error);
  }
});

export default router;