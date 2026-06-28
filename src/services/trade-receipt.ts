import { createHash } from "crypto";

export interface TradeReceiptParams {
  buyerAddress: string;
  sellerAddress: string;
  marketId: string;
  outcome: string;
  quantity: number;
  price: number;
  timestamp: number;
}

/**
 * Compute a deterministic SHA-256 receipt hash for a trade execution.
 *
 * Fields are serialised in sorted-key order so the canonical form is stable
 * regardless of the order they were provided by the caller.
 */
export function computeTradeHash(params: TradeReceiptParams): string {
  const canonical = JSON.stringify({
    buyerAddress: params.buyerAddress,
    marketId: params.marketId,
    outcome: params.outcome,
    price: params.price,
    quantity: params.quantity,
    sellerAddress: params.sellerAddress,
    timestamp: params.timestamp,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
