/**
 * Core data models for the trading orders API
 */

export interface Order {
  id: string;
  marketId: string;
  userAddress: string;
  side: "buy" | "sell";
  outcome: string;
  orderType: "limit" | "market";
  price?: number;
  originalQuantity: number;
  remainingQuantity: number;
  status: "pending" | "partial" | "filled" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
}

export interface Trade {
  id: string;
  buyOrderId: string;
  sellOrderId: string;
  price: number;
  quantity: number;
  timestamp: Date;
  buyerAddress: string;
  sellerAddress: string;
}

export interface Position {
  id: string;
  userAddress: string;
  marketId: string;
  outcome: string;
  quantity: number;
  averagePrice: number;
  totalValue: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Market {
  id: string;
  title: string;
  outcomes: string[];
  status: "active" | "closed" | "resolved";
  createdAt: Date;
  resolvedAt?: Date;
}

export interface OrderBook {
  marketId: string;
  buyOrders: Order[];
  sellOrders: Order[];
}

export interface PositionUpdate {
  userAddress: string;
  marketId: string;
  outcome: string;
  quantityChange: number;
  valueChange: number;
}
