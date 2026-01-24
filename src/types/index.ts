// Core types for Vatix Protocol


export type Order = {
  id: string;
  /** Market ID where the trade occurred */
  marketId: string;
  /** Outcome that was traded (YES or NO) */
  outcome: Outcome;
  /** Stellar address of the buyer */
  buyerAddress: string;
  /** Stellar address of the seller */
  sellerAddress: string;
  /** Price at which the trade executed (0-1) */
  price: number;
  /** Quantity of shares traded */
  quantity: number;
  /** ID of the buy order */
  buyOrderId: string;
  /** ID of the sell order */
  sellOrderId: string;
  /** Timestamp of the trade execution */
  timestamp: number;
}

/**
 * Depth at a single price level in the order book.
 * Aggregates all orders at a specific price point.
 */
export interface OrderBookLevel {
  /** Price level (0-1) */
  price: number;
  /** Total quantity of shares at this price level */
  totalQuantity: number;
  /** Number of orders at this price level */
  orderCount: number;
}

/**
 * Complete order book for a market outcome.
 * Contains all bid and ask levels for a specific outcome.
 */
export interface OrderBook {
  /** Market ID */
  marketId: string;
  /** Outcome this order book represents (YES or NO) */
  outcome: Outcome;
  /** Array of bid levels (buy orders), sorted by price descending */
  bids: OrderBookLevel[];
  /** Array of ask levels (sell orders), sorted by price ascending */
  asks: OrderBookLevel[];
  /** Timestamp when the order book was last updated */
  lastUpdated: number;
}

/**
 * User position with calculated payout information.
 * Extends the Prisma UserPosition type with potential payout calculations.
 */
export interface PositionWithPayout extends UserPosition {
  /** Potential payout if the market resolves to YES (calculated) */
  potentialPayoutIfYes: number;
  /** Potential payout if the market resolves to NO (calculated) */
  potentialPayoutIfNo: number;
  /** Net position value (calculated: yesShares - noShares) */
  netPosition: number;
}

/**
 * Market with aggregated statistics.
 * Extends the Prisma Market type with calculated statistics.
 */
export interface MarketWithStats extends Market {
  /** Total trading volume in the market (calculated) */
  totalVolume: number;
  /** Number of currently open orders (calculated) */
  openOrders: number;
  /** Number of unique traders who have participated (calculated) */
  uniqueTraders: number;
}

/**
 * Generic API response wrapper.
 * Provides a consistent structure for all API responses.
 * @template T - The type of data contained in the response
 */
export interface ApiResponse<T> {
  /** Whether the request was successful */
  success: boolean;
  /** Response data (present on success) */
  data?: T;
  /** Error message (present on failure) */
  error?: string;
  /** ISO timestamp of the response */
  timestamp: string;
}

/**
 * Pagination parameters for list queries.
 * Used to request paginated data from API endpoints.
 */
export interface PaginationParams {
  /** Page number (1-indexed) */
  page: number;
  /** Number of items per page */
  limit: number;
  /** Optional field to sort by */
  sortBy?: string;
  /** Optional sort direction */
  sortOrder?: "asc" | "desc";
}

/**
 * Paginated response containing a list of items.
 * Provides metadata for pagination along with the data.
 * @template T - The type of items in the response
 */
export interface PaginatedResponse<T> {
  /** Array of items for the current page */
  items: T[];
  /** Total number of items across all pages */
  total: number;
  /** Current page number */
  page: number;
  /** Number of items per page */
  limit: number;
  /** Total number of pages */
  totalPages: number;
}
