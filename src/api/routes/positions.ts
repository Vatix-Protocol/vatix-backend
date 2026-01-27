import { Router, Request, Response, NextFunction } from "express";
import { getPrismaClient } from "../../services/prisma";
import { AppError } from "../middleware/errors";

const router = Router();

/**
 * GET /positions/user/:address
 * Retrieves all market positions for a specific Stellar address.
 */
router.get(
  "/user/:address",
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { address } = req.params;
      const prisma = getPrismaClient();

      // Stellar Address Validation (G... 56 chars)
      if (!/^G[A-Z0-9]{55}$/.test(address)) {
        throw new AppError(400, "Invalid Stellar address format");
      }

      // Query positions with market join
      const positions = await prisma.userPosition.findMany({
        where: { userAddress: address },
        include: {
          market: true,
        },
      });

      // Calculate potential payout
      const results = positions.map((p) => ({
        ...p,
        potentialPayout: Math.max(p.yesShares, p.noShares),
      }));

      return res.status(200).json(results);
    } catch (error) {
      next(error);
    }
  }
);

export default router;
