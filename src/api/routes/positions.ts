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
  /** Realized PnL for settled positions (unit: shares * price, i.e. collateral units).
   *  Derived from market.outcome and locked collateral at settlement.
   *  Null when position is not yet settled. */
  pnlRealized: string | null;
  /** Unrealized PnL for open positions.
   *  Pricing source: best-bid mid-price from open orders on this market snapshot.
   *  Null when position is settled or no open orders exist to price the position. */
  pnlUnrealized: string | null;
}

interface WalletPositionsResponse {
  wallet: string;
  exposures: WalletExposureRow[];
  count: number;
  /** Sum of pnlRealized across all settled positions. Currency: collateral units (8 decimal places). */
  pnlRealized: string;
  /** Sum of pnlUnrealized across all open positions that could be priced. Currency: collateral units (8 decimal places). */
  pnlUnrealized: string;
  /** Total PnL = pnlRealized + pnlUnrealized. Currency: collateral units (8 decimal places). */
  pnlTotal: string;
}

/**
 * Compute realized PnL for a settled position.
 *
 * A binary prediction market share pays out 1 unit of collateral if the
 * chosen outcome wins, 0 if it loses.  The cost basis is lockedCollateral.
 *
 *   pnlRealized = winningShares * 1 - lockedCollateral
 *
 * Precision: all arithmetic is done in integer stroops (1e8) to avoid
 * floating-point drift, then formatted back to 8 decimal places.
 */
function computeRealizedPnl(
  yesShares: number,
  noShares: number,
  lockedCollateralStr: string,
  outcome: boolean // true = YES won, false = NO won
): string {
  const PRECISION = 100_000_000n; // 1e8
  const winningShares = BigInt(outcome ? yesShares : noShares);
  // lockedCollateral is already in collateral units with up to 8 decimals
  const [whole, frac = ""] = lockedCollateralStr.split(".");
  const fracPadded = frac.padEnd(8, "0").slice(0, 8);
  const costBasisStroops = BigInt(whole) * PRECISION + BigInt(fracPadded);
  const payoutStroops = winningShares * PRECISION;
  const pnlStroops = payoutStroops - costBasisStroops;
  // Format back to 8 decimal places, preserving sign
  const sign = pnlStroops < 0n ? "-" : "";
  const abs = pnlStroops < 0n ? -pnlStroops : pnlStroops;
  const wholeOut = abs / PRECISION;
  const fracOut = (abs % PRECISION).toString().padStart(8, "0");
  return `${sign}${wholeOut}.${fracOut}`;
}

/**
 * Compute unrealized PnL for an open position.
 *
 * Pricing source: snapshot of open orders for this market.
 * We use the best YES ask price as the current mark price for YES shares,
 * and (1 - best YES ask) as the implied price for NO shares.
 * If no open orders exist, returns null (position cannot be priced).
 *
 *   markValue = yesShares * yesPrice + noShares * (1 - yesPrice)
 *   pnlUnrealized = markValue - lockedCollateral
 */
function computeUnrealizedPnl(
  yesShares: number,
  noShares: number,
  lockedCollateralStr: string,
  yesMidPrice: number | null
): string | null {
  if (yesMidPrice === null) return null;
  const PRECISION = 100_000_000n;
  const noMidPrice = 1 - yesMidPrice;
  // Convert prices to stroops
  const yesPriceStroops = BigInt(Math.round(yesMidPrice * 1e8));
  const noPriceStroops = BigInt(Math.round(noMidPrice * 1e8));
  const markValueStroops =
    BigInt(yesShares) * yesPriceStroops + BigInt(noShares) * noPriceStroops;
  const [whole, frac = ""] = lockedCollateralStr.split(".");
  const fracPadded = frac.padEnd(8, "0").slice(0, 8);
  const costBasisStroops = BigInt(whole) * PRECISION + BigInt(fracPadded);
  const pnlStroops = markValueStroops - costBasisStroops;
  const sign = pnlStroops < 0n ? "-" : "";
  const abs = pnlStroops < 0n ? -pnlStroops : pnlStroops;
  const wholeOut = abs / PRECISION;
  const fracOut = (abs % PRECISION).toString().padStart(8, "0");
  return `${sign}${wholeOut}.${fracOut}`;
}

/** Add two 8-decimal fixed-point strings (may be negative). */
function addFixedPoint(a: string, b: string): string {
  const PRECISION = 100_000_000n;
  const parse = (s: string): bigint => {
    const neg = s.startsWith("-");
    const abs = neg ? s.slice(1) : s;
    const [w, f = ""] = abs.split(".");
    const stroops =
      BigInt(w) * PRECISION + BigInt(f.padEnd(8, "0").slice(0, 8));
    return neg ? -stroops : stroops;
  };
  const sum = parse(a) + parse(b);
  const sign = sum < 0n ? "-" : "";
  const absSum = sum < 0n ? -sum : sum;
  const wholeOut = absSum / PRECISION;
  const fracOut = (absSum % PRECISION).toString().padStart(8, "0");
  return `${sign}${wholeOut}.${fracOut}`;
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
