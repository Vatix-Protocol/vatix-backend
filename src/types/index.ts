// Core types for Vatix Protocol


export type Order = {
  id: string;
  market_id: string;
  user: string;
  side: "BUY" | "SELL";
  outcome: "YES" | "NO";
  price: number; // 0-1
  quantity: number;
  timestamp: number;
};

export type UserPosition = {
  yes_shares: number;
  no_shares: number;
  locked_collateral: number;
};

export type MarketStatus = "ACTIVE" | "RESOLVED" | "CANCELLED";
