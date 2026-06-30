import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getPrismaClient } from "../../services/prisma.js";
import {
  STELLAR_PUBLIC_KEY_REGEX,
  validateUserAddress,
} from "../../matching/validation.js";
import { NotFoundError, ValidationError } from "../middleware/errors.js";
import { heavyReadLimiter } from "../middleware/rateLimiter.js";
import { success } from "../middleware/responses.js";

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
   *  Only present when the request opts in via ?includePnl=true.
   *  Null when position is not yet settled. */
  pnlRealized?: string | null;
  /** Unrealized PnL for open positions.
   *  Pricing source: best-bid mid-price from open orders on this market snapshot.
   *  Only present when the request opts in via ?includePnl=true.
   *  Null when position is settled or no open orders exist to price the position. */
  pnlUnrealized?: string | null;
}

interface WalletPositionsResponse {
  wallet: string;
  exposures: WalletExposureRow[];
  count: number;
  /** Sum of pnlRealized across all settled positions. Currency: collateral units (8 decimal places).
   *  Only present when the request opts in via ?includePnl=true. */
  pnlRealized?: string;
  /** Sum of pnlUnrealized across all open positions that could be priced. Currency: collateral units (8 decimal places).
   *  Only present when the request opts in via ?includePnl=true. */
  pnlUnrealized?: string;
  /** Total PnL = pnlRealized + pnlUnrealized. Currency: collateral units (8 decimal places).
   *  Only present when the request opts in via ?includePnl=true. */
  pnlTotal?: string;
}

interface GetWalletPositionsParams {
  wallet: string;
}

interface GetWalletPositionsQuery {
  /** Opt into PnL calculation. Defaults to false — PnL pricing requires an
   *  extra order-book query per market, so it's skipped unless requested. */
  includePnl?: boolean;
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
  server.get<{
    Params: GetWalletPositionsParams;
    Querystring: GetWalletPositionsQuery;
  }>(
    "/wallets/:wallet/positions",
    {
      onRequest: [heavyReadLimiter],
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
        querystring: {
          type: "object",
          properties: {
            includePnl: {
              type: "boolean",
              description:
                "When true, computes and includes realized/unrealized PnL per position and in the response summary. Defaults to false.",
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: GetWalletPositionsParams;
        Querystring: GetWalletPositionsQuery;
      }>,
      reply: FastifyReply
    ) => {
      const { wallet } = request.params;
      const { includePnl = false } = request.query;
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

      // Fetch best bid/ask per market for unrealized PnL pricing — skipped
      // unless PnL was requested, since it's an extra query per market.
      const marketIds = [...new Set(positions.map((p) => p.marketId))];
      const orderGroups =
        includePnl && marketIds.length > 0
          ? await (prisma as any).order.groupBy({
              by: ["marketId", "side"],
              where: {
                marketId: { in: marketIds },
                status: { in: ["OPEN", "PARTIALLY_FILLED"] },
                outcome: "YES",
              },
              _min: { price: true },
              _max: { price: true },
            })
          : [];

      // Build mid-price map per market
      const midPriceMap = new Map<string, number | null>();
      for (const marketId of marketIds) {
        const ask = orderGroups.find(
          (g: any) => g.marketId === marketId && g.side === "SELL"
        );
        const bid = orderGroups.find(
          (g: any) => g.marketId === marketId && g.side === "BUY"
        );
        const askPrice = ask?._min?.price ? Number(ask._min.price) : null;
        const bidPrice = bid?._max?.price ? Number(bid._max.price) : null;
        if (askPrice !== null && bidPrice !== null) {
          midPriceMap.set(marketId, (askPrice + bidPrice) / 2);
        } else if (askPrice !== null) {
          midPriceMap.set(marketId, askPrice);
        } else if (bidPrice !== null) {
          midPriceMap.set(marketId, bidPrice);
        } else {
          midPriceMap.set(marketId, null);
        }
      }

      const exposures: WalletExposureRow[] = positions.map((position) => {
        const market = position.market as any;
        const lockedCollateral = position.lockedCollateral.toString();

        const base: WalletExposureRow = {
          marketId: market.id,
          marketQuestion: market.question,
          yesShares: position.yesShares,
          noShares: position.noShares,
          netExposure: position.yesShares - position.noShares,
          lockedCollateral,
          isSettled: position.isSettled,
          updatedAt: position.updatedAt,
        };

        if (!includePnl) {
          return base;
        }

        let pnlRealized: string | null = null;
        let pnlUnrealized: string | null = null;

        if (position.isSettled && market.outcome !== null) {
          pnlRealized = computeRealizedPnl(
            position.yesShares,
            position.noShares,
            lockedCollateral,
            market.outcome as boolean
          );
        } else if (!position.isSettled) {
          const midPrice = midPriceMap.get(position.marketId) ?? null;
          pnlUnrealized = computeUnrealizedPnl(
            position.yesShares,
            position.noShares,
            lockedCollateral,
            midPrice
          );
        }

        return { ...base, pnlRealized, pnlUnrealized };
      });

      request.log.info(
        { wallet, positionCount: exposures.length, includePnl },
        "wallet positions fetched"
      );

      const response: WalletPositionsResponse = {
        wallet,
        exposures,
        count: exposures.length,
      };

      if (includePnl) {
        const ZERO = "0.00000000";
        response.pnlRealized = exposures
          .filter((e) => e.pnlRealized !== null && e.pnlRealized !== undefined)
          .reduce((acc, e) => addFixedPoint(acc, e.pnlRealized!), ZERO);
        response.pnlUnrealized = exposures
          .filter(
            (e) => e.pnlUnrealized !== null && e.pnlUnrealized !== undefined
          )
          .reduce((acc, e) => addFixedPoint(acc, e.pnlUnrealized!), ZERO);
        response.pnlTotal = addFixedPoint(
          response.pnlRealized,
          response.pnlUnrealized
        );
      }

      success(reply, response);
    }
  );

  server.get<{
    Params: { wallet: string; marketId: string };
  }>(
    "/wallets/:wallet/positions/:marketId",
    {
      onRequest: [heavyReadLimiter],
      schema: {
        params: {
          type: "object",
          required: ["wallet", "marketId"],
          properties: {
            wallet: {
              type: "string",
              pattern: STELLAR_PUBLIC_KEY_REGEX.source,
              description:
                "Stellar public key (StrKey): starts with G and is 56 chars using [A-Z2-7]",
            },
            marketId: {
              type: "string",
              description: "Market ID to fetch position for",
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{
        Params: { wallet: string; marketId: string };
      }>,
      reply: FastifyReply
    ) => {
      const { wallet, marketId } = request.params;
      const prisma = getPrismaClient();

      const addressError = validateUserAddress(wallet);
      if (addressError) {
        throw new ValidationError(addressError);
      }

      const position = await prisma.userPosition.findFirst({
        where: { userAddress: wallet, marketId },
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
      });

      if (!position) {
        throw new NotFoundError(
          `No position found for wallet in market ${marketId}`
        );
      }

      const market = position.market as any;
      const lockedCollateral = position.lockedCollateral.toString();

      const exposure: WalletExposureRow = {
        marketId: market.id,
        marketQuestion: market.question,
        yesShares: position.yesShares,
        noShares: position.noShares,
        netExposure: position.yesShares - position.noShares,
        lockedCollateral,
        isSettled: position.isSettled,
        updatedAt: position.updatedAt,
      };

      request.log.info({ wallet, marketId }, "wallet market position fetched");

      success(reply, { wallet, marketId, position: exposure });
    }
  );
}
