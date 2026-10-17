import type { Market, MarketStatus, Outcome } from "../../types/index.js";

export interface MarketListItemDto {
  id: string;
  question: string;
  endTime: string;
  status: MarketStatus;
  outcome: Outcome | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketDetailsDto {
  id: string;
  question: string;
  endTime: string;
  resolutionTime: string | null;
  oracleAddress: string;
  status: MarketStatus;
  outcome: Outcome | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrderBookLevelDto {
  price: number;
  outcome: Outcome;
  totalQuantity: number;
  orderCount: number;
}

export interface MarketOrderBookDto {
  marketId: string;
  snapshotTimestamp: string;
  ledgerSequence: number | null;
  bids: OrderBookLevelDto[];
  asks: OrderBookLevelDto[];
}

/**
 * Compute a weak ETag for a market row, used for If-Match concurrency
 * control on market update endpoints.
 *
 * The validator is a pure function of the market id and the row's
 * last-modified instant. The timestamp component is derived from
 * `updatedAt.toISOString()` so the same instant always yields the same
 * string regardless of how the Date was constructed (driver string, JSON
 * round-trip, etc.). The format is `W/"<id>-<iso>"` and is pinned by tests
 * in market.dto.test.ts — changing it invalidates every client's cached
 * validator, so do so deliberately.
 *
 * Throws if `updatedAt` is not a valid Date, rather than emitting a
 * non-deterministic validator.
 */
export function computeMarketEtag(
  market: Pick<Market, "id" | "updatedAt">
): string {
  const updatedAt = market.updatedAt;
  if (!(updatedAt instanceof Date) || Number.isNaN(updatedAt.getTime())) {
    throw new Error(
      `computeMarketEtag: invalid updatedAt for market ${market.id}`
    );
  }
  return `W/"${market.id}-${updatedAt.toISOString()}"`;
}
