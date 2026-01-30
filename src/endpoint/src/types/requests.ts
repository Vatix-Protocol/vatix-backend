/**
 * Request and response types for the API
 */

export interface OrderRequest {
  marketId: string;
  side: "buy" | "sell";
  outcome: string;
  price?: number; // Optional for market orders
  quantity: number;
  userAddress: string; // Extracted from auth
}

export interface OrderResponse {
  success: boolean;
  orderId: string;
  receipt: SignedReceipt;
  trades?: Trade[];
  error?: string;
}

export interface SignedReceipt {
  orderId: string;
  timestamp: Date;
  orderDetails: Order;
  trades: Trade[];
  signature: string;
  publicKey: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface MatchResult {
  trades: Trade[];
  remainingOrder?: Order;
  updatedOrders: Order[];
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, string>;
    timestamp: string;
    requestId: string;
  };
}

// Import types from models
import { Order, Trade } from "./models";
