import { FastifyInstance } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import {
  STELLAR_PUBLIC_KEY_REGEX,
  validateUserAddress,
} from "../../matching/validation.js";
import { ValidationError } from "../middleware/errors.js";
import { success } from "../middleware/responses.js";
import { heavyReadLimiter } from "../middleware/rateLimiter.js";

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
    async (
      request: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply
    ) => {
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
              outcome: true,
              status: true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      });

      // Snapshot: fetch best YES ask price per market for open positions
      const openMarketIds = positions
        .filter((p) => !p.isSettled)
        .map((p) => p.marketId);

      // yesMidPriceByMarket: marketId -> mid price (0-1) or null
      const yesMidPriceByMarket = new Map<string, number | null>();

      if (openMarketIds.length > 0) {
        // For each open market, get the best YES ask (lowest sell price) and
        // best YES bid (highest buy price) to compute a mid price.
        const priceRows = await prisma.order.groupBy({
          by: ["marketId", "side"],
          where: {
            marketId: { in: openMarketIds },
            outcome: "YES",
            status: { in: ["OPEN", "PARTIALLY_FILLED"] },
          },
          _min: { price: true }, // best ask (lowest sell)
          _max: { price: true }, // best bid (highest buy)
        });

        // Build per-market bid/ask
        const byMarket = new Map<string, { bid?: number; ask?: number }>();
        for (const row of priceRows) {
          const entry = byMarket.get(row.marketId) ?? {};
          if (row.side === "SELL" && row._min.price != null) {
            entry.ask = Number(row._min.price);
          }
          if (row.side === "BUY" && row._max.price != null) {
            entry.bid = Number(row._max.price);
          }
          byMarket.set(row.marketId, entry);
        }

        for (const marketId of openMarketIds) {
          const entry = byMarket.get(marketId);
          if (!entry) {
            yesMidPriceByMarket.set(marketId, null);
          } else if (entry.bid != null && entry.ask != null) {
            yesMidPriceByMarket.set(marketId, (entry.bid + entry.ask) / 2);
          } else if (entry.ask != null) {
            yesMidPriceByMarket.set(marketId, entry.ask);
          } else if (entry.bid != null) {
            yesMidPriceByMarket.set(marketId, entry.bid);
          } else {
            yesMidPriceByMarket.set(marketId, null);
          }
        }
      }

      let totalRealizedStroops = 0n;
      let totalUnrealizedStroops = 0n;
      const PRECISION = 100_000_000n;

      const exposures: WalletExposureRow[] = positions.map((position) => {
        const collateralStr = position.lockedCollateral.toString();

        let pnlRealized: string | null = null;
        let pnlUnrealized: string | null = null;

        if (position.isSettled && position.market.outcome != null) {
          pnlRealized = computeRealizedPnl(
            position.yesShares,
            position.noShares,
            collateralStr,
            position.market.outcome
          );
          // Accumulate
          const neg = pnlRealized.startsWith("-");
          const abs = neg ? pnlRealized.slice(1) : pnlRealized;
          const [w, f = ""] = abs.split(".");
          const stroops =
            BigInt(w) * PRECISION + BigInt(f.padEnd(8, "0").slice(0, 8));
          totalRealizedStroops += neg ? -stroops : stroops;
        } else if (!position.isSettled) {
          const midPrice = yesMidPriceByMarket.get(position.marketId) ?? null;
          pnlUnrealized = computeUnrealizedPnl(
            position.yesShares,
            position.noShares,
            collateralStr,
            midPrice
          );
          if (pnlUnrealized !== null) {
            const neg = pnlUnrealized.startsWith("-");
            const abs = neg ? pnlUnrealized.slice(1) : pnlUnrealized;
            const [w, f = ""] = abs.split(".");
            const stroops =
              BigInt(w) * PRECISION + BigInt(f.padEnd(8, "0").slice(0, 8));
            totalUnrealizedStroops += neg ? -stroops : stroops;
          }
        }

        return {
          marketId: position.market.id,
          marketQuestion: position.market.question,
          yesShares: position.yesShares,
          noShares: position.noShares,
          netExposure: position.yesShares - position.noShares,
          lockedCollateral: collateralStr,
          isSettled: position.isSettled,
          updatedAt: position.updatedAt,
          pnlRealized,
          pnlUnrealized,
        };
      });

      const fmt = (stroops: bigint): string => {
        const sign = stroops < 0n ? "-" : "";
        const abs = stroops < 0n ? -stroops : stroops;
        return `${sign}${abs / PRECISION}.${(abs % PRECISION).toString().padStart(8, "0")}`;
      };

      const pnlRealized = fmt(totalRealizedStroops);
      const pnlUnrealized = fmt(totalUnrealizedStroops);
      const pnlTotal = addFixedPoint(pnlRealized, pnlUnrealized);

      const response: WalletPositionsResponse = {
        wallet,
        exposures,
        count: exposures.length,
        pnlRealized,
        pnlUnrealized,
        pnlTotal,
      };

      success(reply, response);
    }
  );

  // Legacy endpoint — heavy read with rate limiter
  server.get(
    "/positions/user/:address",
    { onRequest: [heavyReadLimiter] },
    async (
      request: import("fastify").FastifyRequest,
      reply: import("fastify").FastifyReply
    ) => {
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

      const results = positions.map((p) => ({
        ...p,
        potentialPayoutIfYes: p.yesShares,
        potentialPayoutIfNo: p.noShares,
        netPosition: p.yesShares - p.noShares,
      }));

      return results;
    }
  );
}
