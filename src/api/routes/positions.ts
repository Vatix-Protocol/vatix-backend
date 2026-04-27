import { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import { validateUserAddress } from "../../matching/validation.js";
import { ValidationError } from "../middleware/errors.js";
import { heavyReadLimiter } from "../middleware/rateLimiter.js";

interface PositionResult {
  yesShares: number;
  noShares: number;
  [key: string]: any;
}

export default async function positionsRouter(server: FastifyInstance) {
  // Heavy read: findMany with market JOIN — apply stricter limit.
  server.get("/positions/user/:address", { onRequest: [heavyReadLimiter] }, async (request, reply) => {
    const { address } = request.params as { address: string };
    const prisma = getPrismaClient();

    const addressError = validateUserAddress(address);
    if (addressError) {
      throw new ValidationError(addressError);
    }

    const positions = await prisma.userPosition.findMany({
      where: { userAddress: address },
      include: { market: true },
    });

    const results = positions.map((p: PositionResult) => ({
      ...p,
      potentialPayoutIfYes: p.yesShares,
      potentialPayoutIfNo: p.noShares,
      netPosition: p.yesShares - p.noShares,
    }));

    return results;
  });
}
