import type { MarketStatus, Outcome } from "../../types/index.js";

export interface MarketListItemDto {
  id: string;
  question: string;
  endTime: string;
  resolutionTime: string | null;
  oracleAddress: string;
  status: MarketStatus;
  outcome: boolean | null;
  createdAt: string;
  updatedAt: string;
}

export interface MarketDetailsDto extends MarketListItemDto {}

export interface OrderBookLevelDto {
  /** Price level expressed as a decimal in the range 0-1 */
  price: number;
  /** Total quantity available at this price level */
  totalQuantity: number;
  /** Number of orders aggregated into this price level */
  orderCount: number;
  /** Outcome associated with this order level (YES or NO) */
  outcome: Outcome;
}

export interface MarketOrderBookDto {
  marketId: string;
  snapshotTimestamp: string;
  ledgerSequence: number | null;
  bids: OrderBookLevelDto[];
  asks: OrderBookLevelDto[];
}
