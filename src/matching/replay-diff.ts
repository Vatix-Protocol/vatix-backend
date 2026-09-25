/**
 * Structured divergence report: ledger (Order/Trade rows) vs. a replayed
 * OrderBook, optionally cross-checked against a cached Redis depth snapshot.
 *
 * See docs/replay-forensics.md for when to run this and how to read a
 * divergence report.
 */
import type { Outcome, OrderSide } from "../types/index.js";
import type { ReplayResult } from "./replay.js";

export interface LedgerOrder {
  id: string;
  userAddress: string;
  side: OrderSide;
  price: number;
  quantity: number;
  filledQuantity: number;
  status: "OPEN" | "FILLED" | "CANCELLED" | "PARTIALLY_FILLED";
}

export interface LedgerTrade {
  buyOrderId: string;
  sellOrderId: string;
  quantity: number;
  price: number;
}

export interface DepthSnapshot {
  bids: Array<{ price: number; quantity: number }>;
  asks: Array<{ price: number; quantity: number }>;
}

export interface OrderMismatch {
  orderId: string;
  field: "filledQuantity" | "remaining" | "status";
  expected: unknown;
  actual: unknown;
}

export interface DepthDelta {
  side: "bid" | "ask";
  price: number;
  expectedQuantity: number;
  actualQuantity: number;
}

export interface ReplayDivergenceReport {
  marketId: string;
  outcome: Outcome;
  asOf: string;
  ordersReplayed: number;
  tradesReplayed: number;
  orderMismatches: OrderMismatch[];
  missingOrderIds: string[];
  extraOrderIds: string[];
  missingTrades: string[];
  extraTrades: string[];
  depthDeltas: DepthDelta[];
  cancelAmbiguities: string[];
  hasDivergence: boolean;
}

function tradeKey(
  buyOrderId: string,
  sellOrderId: string,
  quantity: number,
  price: number
): string {
  return `${buyOrderId}:${sellOrderId}:${quantity}:${price}`;
}

function diffMultisets(
  expected: string[],
  actual: string[]
): { missing: string[]; extra: string[] } {
  const expectedCounts = new Map<string, number>();
  for (const k of expected)
    expectedCounts.set(k, (expectedCounts.get(k) ?? 0) + 1);
  const actualCounts = new Map<string, number>();
  for (const k of actual) actualCounts.set(k, (actualCounts.get(k) ?? 0) + 1);

  const missing: string[] = [];
  for (const [key, count] of expectedCounts) {
    const have = actualCounts.get(key) ?? 0;
    for (let i = have; i < count; i++) missing.push(key);
  }

  const extra: string[] = [];
  for (const [key, count] of actualCounts) {
    const want = expectedCounts.get(key) ?? 0;
    for (let i = want; i < count; i++) extra.push(key);
  }

  return { missing, extra };
}

function diffDepthSide(
  side: "bid" | "ask",
  expected: Array<{ price: number; quantity: number }>,
  actual: Array<{ price: number; quantity: number }>
): DepthDelta[] {
  const expectedByPrice = new Map(expected.map((l) => [l.price, l.quantity]));
  const actualByPrice = new Map(actual.map((l) => [l.price, l.quantity]));
  const prices = new Set([...expectedByPrice.keys(), ...actualByPrice.keys()]);

  const deltas: DepthDelta[] = [];
  for (const price of prices) {
    const expectedQuantity = expectedByPrice.get(price) ?? 0;
    const actualQuantity = actualByPrice.get(price) ?? 0;
    if (expectedQuantity !== actualQuantity) {
      deltas.push({ side, price, expectedQuantity, actualQuantity });
    }
  }
  return deltas.sort((a, b) => a.price - b.price);
}

/**
 * Build a structured divergence report comparing ledger truth (Order/Trade
 * rows) against a replayed OrderBook, and optionally a cached Redis depth
 * snapshot.
 *
 * `cancelAmbiguities` should list order ids whose cancel timing had to be
 * approximated (see replay-market.ts's anchoring logic) — they are surfaced
 * separately from hard divergences since they represent a known data gap
 * (no `cancelledAt` timestamp exists yet), not necessarily a bug.
 */
export function buildDivergenceReport(params: {
  marketId: string;
  outcome: Outcome;
  asOf: Date;
  ledgerOrders: LedgerOrder[];
  ledgerTrades: LedgerTrade[];
  replay: ReplayResult;
  redisSnapshot?: DepthSnapshot | null;
  cancelAmbiguities?: string[];
}): ReplayDivergenceReport {
  const { marketId, outcome, asOf, ledgerOrders, ledgerTrades, replay } =
    params;

  const orderMismatches: OrderMismatch[] = [];
  const missingOrderIds: string[] = [];
  const extraOrderIds: string[] = [];

  const ledgerById = new Map(ledgerOrders.map((o) => [o.id, o]));

  for (const ledgerOrder of ledgerOrders) {
    const replayed = replay.orders.get(ledgerOrder.id);
    const expectedRemaining = ledgerOrder.quantity - ledgerOrder.filledQuantity;
    const expectedResting =
      (ledgerOrder.status === "OPEN" ||
        ledgerOrder.status === "PARTIALLY_FILLED") &&
      expectedRemaining > 0;

    if (!replayed) {
      if (expectedResting) missingOrderIds.push(ledgerOrder.id);
      continue;
    }

    if (replayed.filledQuantity !== ledgerOrder.filledQuantity) {
      orderMismatches.push({
        orderId: ledgerOrder.id,
        field: "filledQuantity",
        expected: ledgerOrder.filledQuantity,
        actual: replayed.filledQuantity,
      });
    }

    if (replayed.remaining !== expectedRemaining) {
      orderMismatches.push({
        orderId: ledgerOrder.id,
        field: "remaining",
        expected: expectedRemaining,
        actual: replayed.remaining,
      });
    }

    const replayedRestingNow = replayed.remaining > 0;
    if (replayedRestingNow !== expectedResting) {
      orderMismatches.push({
        orderId: ledgerOrder.id,
        field: "status",
        expected: expectedResting ? "resting" : "not resting",
        actual: replayedRestingNow ? "resting" : "not resting",
      });
    }
  }

  for (const orderId of replay.orders.keys()) {
    if (!ledgerById.has(orderId)) {
      extraOrderIds.push(orderId);
    }
  }

  const expectedTradeKeys = ledgerTrades.map((t) =>
    tradeKey(t.buyOrderId, t.sellOrderId, t.quantity, t.price)
  );
  const actualTradeKeys = replay.trades.map((t) =>
    tradeKey(t.buyOrderId, t.sellOrderId, t.quantity, t.price)
  );
  const { missing: missingTrades, extra: extraTrades } = diffMultisets(
    expectedTradeKeys,
    actualTradeKeys
  );

  let depthDeltas: DepthDelta[] = [];
  if (params.redisSnapshot) {
    const replayDepth = params.replay.book.getDepth(Number.MAX_SAFE_INTEGER);
    depthDeltas = [
      ...diffDepthSide("bid", params.redisSnapshot.bids, replayDepth.bids),
      ...diffDepthSide("ask", params.redisSnapshot.asks, replayDepth.asks),
    ];
  }

  const hasDivergence =
    orderMismatches.length > 0 ||
    missingOrderIds.length > 0 ||
    extraOrderIds.length > 0 ||
    missingTrades.length > 0 ||
    extraTrades.length > 0 ||
    depthDeltas.length > 0;

  return {
    marketId,
    outcome,
    asOf: asOf.toISOString(),
    ordersReplayed: ledgerOrders.length,
    tradesReplayed: replay.trades.length,
    orderMismatches,
    missingOrderIds,
    extraOrderIds,
    missingTrades,
    extraTrades,
    depthDeltas,
    cancelAmbiguities: params.cancelAmbiguities ?? [],
    hasDivergence,
  };
}
