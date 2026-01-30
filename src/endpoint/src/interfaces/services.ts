/**
 * Service interfaces for the trading orders API
 */

import {
  Order,
  Trade,
  Position,
  OrderBook,
  PositionUpdate,
} from "../types/models";
import {
  OrderRequest,
  OrderResponse,
  ValidationResult,
  MatchResult,
  SignedReceipt,
} from "../types/requests";

export interface OrderController {
  submitOrder(request: OrderRequest): Promise<OrderResponse>;
}

export interface OrderValidator {
  validate(order: OrderRequest): ValidationResult;
}

export interface MatchingEngine {
  matchOrder(order: Order, orderBook: OrderBook): MatchResult;
}

export interface OrderBookCache {
  addOrder(order: Order): Promise<void>;
  removeOrder(orderId: string): Promise<void>;
  updateOrder(orderId: string, newQuantity: number): Promise<void>;
  getOrderBook(marketId: string): Promise<OrderBook>;
  getOrder(orderId: string): Promise<Order | null>;
}

export interface DatabaseManager {
  createOrder(order: Order): Promise<Order>;
  updateOrder(orderId: string, updates: Partial<Order>): Promise<Order>;
  createTrades(trades: Trade[]): Promise<Trade[]>;
  updatePositions(updates: PositionUpdate[]): Promise<void>;
}

export interface PositionManager {
  calculatePositionUpdates(trades: Trade[]): PositionUpdate[];
  applyPositionUpdates(updates: PositionUpdate[]): Promise<void>;
}

export interface SigningService {
  generateReceipt(order: Order, trades: Trade[]): Promise<SignedReceipt>;
}

export interface AuthHandler {
  extractUserAddress(headers: Record<string, string>): Promise<string>;
  validateAuthentication(token: string): Promise<boolean>;
}

export interface TransactionManager {
  executeInTransaction<T>(operation: () => Promise<T>): Promise<T>;
}
