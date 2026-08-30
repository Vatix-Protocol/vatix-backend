/**
 * Deterministic order/trade replay over a fresh OrderBook (#forensics).
 *
 * Replays a market+outcome's order history through the *same* matching
 * engine (`matchOrder`) used in production, in a fresh, isolated `OrderBook`.
 * This is the pure, DB/Redis-free core used by both the golden test corpus
 * and the `scripts/replay-market.ts` forensics CLI — see docs/replay-forensics.md
 * for how the two layers fit together and how to interpret a divergence.
 *
 * Hydrating only the currently-resting orders (as `matching-service.ts`
 * does on cold start) can never catch a historical fill-accounting bug: it
 * trusts `filledQuantity`/`status` as given. Replaying the full order
 * arrival sequence through `matchOrder` instead re-derives every trade from
 * scratch, so any divergence between "what the engine would have done" and
 * "what actually got recorded" surfaces immediately.
 */
import type { Outcome, OrderSide } from "../types/index.js";
import { OrderBook, type Order as BookOrder } from "./orderbook.js";
import { matchOrder, outcomeToNumber, type Trade } from "./engine.js";

/** A resting/taker order entering the book, in arrival order. */
export interface ReplayOrderCreate {
  type: "create";
  id: string;
  userAddress: string;
  side: OrderSide;
  price: number;
  quantity: number;
  timestamp: number;
}

/** An order leaving the book without being filled. */
export interface ReplayOrderCancel {
  type: "cancel";
  id: string;
  timestamp: number;
}

export type ReplayEvent = ReplayOrderCreate | ReplayOrderCancel;

export interface ReplayedOrderState {
  id: string;
  userAddress: string;
  side: OrderSide;
  price: number;
  quantity: number;
  filledQuantity: number;
  remaining: number;
}

export interface ReplayResult {
  book: OrderBook;
  trades: Trade[];
  /** Final per-order state derived purely from replaying the event stream. */
  orders: Map<string, ReplayedOrderState>;
}

/**
 * Replay an ordered event stream for a single (marketId, outcome) book.
 *
 * Callers are responsible for ordering `events` deterministically (by
 * `timestamp`, tie-broken by a stable secondary key such as row id) before
 * calling this function — it applies events strictly in the order given.
 *
 * Each `create` event is run through the real `matchOrder` engine against
 * the book being built up so far, exactly mirroring
 * `matching-service.ts#placeOrder`'s in-memory sequence (minus the DB/Redis
 * side effects). Each `cancel` event removes the order from the book with
 * no trade side effects, mirroring `matching-service.ts#cancelOrder`.
 */
export function replayEvents(
  marketId: string,
  outcome: Outcome,
  events: ReplayEvent[]
): ReplayResult {
  const outcomeNum = outcomeToNumber(outcome);
  const book = new OrderBook(marketId, outcomeNum);
  const trades: Trade[] = [];
  const orders = new Map<string, ReplayedOrderState>();

  for (const event of events) {
    if (event.type === "create") {
      orders.set(event.id, {
        id: event.id,
        userAddress: event.userAddress,
        side: event.side,
        price: event.price,
        quantity: event.quantity,
        filledQuantity: 0,
        remaining: event.quantity,
      });

      const result = matchOrder(
        {
          id: event.id,
          userAddress: event.userAddress,
          side: event.side,
          price: event.price,
          quantity: event.quantity,
          marketId,
          outcome,
          timestamp: event.timestamp,
        },
        book
      );

      for (const trade of result.trades) {
        trades.push(trade);
        applyFill(orders, trade.buyOrderId, trade.quantity);
        applyFill(orders, trade.sellOrderId, trade.quantity);
      }

      if (result.remainingOrder) {
        const bookOrder: BookOrder = {
          id: result.remainingOrder.id,
          userAddress: result.remainingOrder.userAddress,
          side: event.side === "BUY" ? "bid" : "ask",
          price: result.remainingOrder.price,
          quantity: result.remainingOrder.quantity,
          timestamp: event.timestamp,
          marketId,
          outcome: outcomeNum,
        };
        book.addOrder(bookOrder);
      }
    } else {
      book.removeOrder(event.id);
    }
  }

  return { book, trades, orders };
}

function applyFill(
  orders: Map<string, ReplayedOrderState>,
  orderId: string,
  quantity: number
): void {
  const state = orders.get(orderId);
  if (!state) return;
  state.filledQuantity += quantity;
  state.remaining = state.quantity - state.filledQuantity;
}
