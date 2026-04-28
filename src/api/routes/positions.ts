import { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import {
  STELLAR_PUBLIC_KEY_REGEX,
  validateUserAddress,
} from "../../matching/validation.js";
import { ValidationError } from "../middleware/errors.js";
import { heavyReadLimiter } from "../middleware/rateLimiter.js";
import { success } from "../middleware/responses.js";

interface PositionResult {
  yesShares: number;
  noShares: number;
  [key: string]: any;
}

interface WalletExposureRow {
  marketId: string;
  marketQuestion: string;
  yesShares: number;
  noShares: number;
  netExposure: number;
  lockedCollateral: string;
  isSettled: boolean;
  updatedAt: Date;
}

export default async function positionsRouter(server: FastifyInstance) {
  server.get(
    "/wallets/:wallet/positions",
    {
      schema: {
        params: {
          type: "object",
          required: ["wallet"],
          properties: {
            wallet: {
              type: "string",
              pattern: STELLAR_PUBLIC_KEY_REGEX.source,
              description:
                "Stellar public key (StrKey): starts with G and is 56 chars using [A-Z2-7]",
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { wallet } = request.params as { wallet: string };
      const prisma = getPrismaClient();

      const addressError = validateUserAddress(wallet);
      if (addressError) {
        throw new ValidationError(addressError);
      }

      const positions = await prisma.userPosition.findMany({
        where: { userAddress: wallet },
        include: {
          market: {
            select: {
              id: true,
              question: true,
            },
          },
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

      const exposures: WalletExposureRow[] = positions.map((position) => ({
        marketId: position.market.id,
        marketQuestion: position.market.question,
        yesShares: position.yesShares,
        noShares: position.noShares,
        netExposure: position.yesShares - position.noShares,
        lockedCollateral: position.lockedCollateral.toString(),
        isSettled: position.isSettled,
        updatedAt: position.updatedAt,
      }));

      success(reply, {
        wallet,
        exposures,
        count: exposures.length,
      });
    }
  );

  // Heavy read: findMany with market JOIN — apply stricter limit.
  server.get(
    "/positions/user/:address",
    { onRequest: [heavyReadLimiter] },
    async (request, reply) => {
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
    }
  );
}
