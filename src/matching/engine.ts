import type { Outcome, OrderSide } from "../types/index.js";
import type { Order as BookOrder } from "./orderbook.js";
import { OrderBook } from "./orderbook.js";
import { canMatchTicks, parsePriceToTicks } from "./price.js";

export interface MatchingOrder {
  id: string;
  userAddress: string;
  side: OrderSide;
  price: number;
  quantity: number;
  marketId: string;
  outcome: Outcome;
  timestamp: number;
}

export interface Trade {
  id: string;
  marketId: string;
  outcome: Outcome;
  buyerAddress: string;
  sellerAddress: string;
  buyOrderId: string;
  sellOrderId: string;
  price: number;
  quantity: number;
  timestamp: number;
}

export interface PositionDelta {
  userAddress: string;
  yesSharesDelta: number;
  noSharesDelta: number;
}

export interface MatchResult {
  trades: Trade[];
  remainingOrder: MatchingOrder | null;
  positionDeltas: PositionDelta[];
}

export interface MatchHooks {
  onTradeFilled?: (trade: Trade) => void;
}

interface MatchCommand {
  execute(): void;
  rollback(): void;
}

class RemoveOrderCommand implements MatchCommand {
  private orderBook: OrderBook;
  private orderId: string;
  private removedOrder: BookOrder | null = null;

  constructor(orderBook: OrderBook, orderId: string) {
    this.orderBook = orderBook;
    this.orderId = orderId;
  }

  execute(): void {
    this.removedOrder = this.orderBook.removeOrder(this.orderId);
  }

  rollback(): void {
    if (this.removedOrder) {
      this.orderBook.addOrder(this.removedOrder);
    }
  }
}

class UpdateQuantityCommand implements MatchCommand {
  private orderBook: OrderBook;
  private orderId: string;
  private newQuantity: number;
  private previousQuantity: number = 0;

  constructor(
    orderBook: OrderBook,
    orderId: string,
    newQuantity: number,
    previousQuantity: number
  ) {
    this.orderBook = orderBook;
    this.orderId = orderId;
    this.newQuantity = newQuantity;
    this.previousQuantity = previousQuantity;
  }

  execute(): void {
    this.orderBook.updateOrderQuantity(this.orderId, this.newQuantity);
  }

  rollback(): void {
    this.orderBook.updateOrderQuantity(this.orderId, this.previousQuantity);
  }
}

/**
 * Convert external Outcome type to internal numeric representation.
 * Use this when converting a MatchingOrder to a BookOrder format
 * (e.g., when adding remaining orders to the OrderBook after matching).
 *
 * @param outcome - External outcome ('YES' or 'NO')
 * @returns Numeric outcome (0 for YES, 1 for NO)
 */
function outcomeToNumber(outcome: Outcome): number {
  return outcome === "YES" ? 0 : 1;
}

/**
 * Price-crossing check for `matchOrder`.
 *
 * Prices are compared as exact integer ticks (see `./price.ts`, #1487) rather
 * than as floats, so a decimal price such as `0.30000000000000004` cannot
 * cross a level it should not (or vice versa).
 */
function canMatch(
  takerPrice: number,
  makerPrice: number,
  takerSide: OrderSide
): boolean {
  return canMatchTicks(
    parsePriceToTicks(String(takerPrice)),
    parsePriceToTicks(String(makerPrice)),
    takerSide
  );
}

function generateTradeId(
  buyOrderId: string,
  sellOrderId: string,
  quantity: number,
  timestamp: number
): string {
  return `trade_${buyOrderId}_${sellOrderId}_${quantity}_${timestamp}`;
}

function createTrade(
  newOrder: MatchingOrder,
  bookOrder: BookOrder,
  quantity: number,
  price: number,
  timestamp: number
): Trade {
  const isBuyer = newOrder.side === "BUY";

  return {
    id: generateTradeId(
      isBuyer ? newOrder.id : bookOrder.id,
      isBuyer ? bookOrder.id : newOrder.id,
      quantity,
      timestamp
    ),
    marketId: newOrder.marketId,
    outcome: newOrder.outcome,
    buyerAddress: isBuyer ? newOrder.userAddress : bookOrder.userAddress,
    sellerAddress: isBuyer ? bookOrder.userAddress : newOrder.userAddress,
    buyOrderId: isBuyer ? newOrder.id : bookOrder.id,
    sellOrderId: isBuyer ? bookOrder.id : newOrder.id,
    price,
    quantity,
    timestamp,
  };
}

function rollbackCommands(commands: MatchCommand[]): void {
  for (let i = commands.length - 1; i >= 0; i--) {
    commands[i].rollback();
  }
}

function calculatePositionDeltas(trades: Trade[]): PositionDelta[] {
  const deltaMap = new Map<string, { yes: number; no: number }>();

  for (const trade of trades) {
    const isYes = trade.outcome === "YES";

    if (!deltaMap.has(trade.buyerAddress)) {
      deltaMap.set(trade.buyerAddress, { yes: 0, no: 0 });
    }
    if (!deltaMap.has(trade.sellerAddress)) {
      deltaMap.set(trade.sellerAddress, { yes: 0, no: 0 });
    }

    const buyerDelta = deltaMap.get(trade.buyerAddress)!;
    const sellerDelta = deltaMap.get(trade.sellerAddress)!;

    if (isYes) {
      buyerDelta.yes += trade.quantity;
      sellerDelta.yes -= trade.quantity;
    } else {
      buyerDelta.no += trade.quantity;
      sellerDelta.no -= trade.quantity;
    }
  }

  const positionDeltas: PositionDelta[] = [];
  for (const [userAddress, delta] of deltaMap) {
    positionDeltas.push({
      userAddress,
      yesSharesDelta: delta.yes,
      noSharesDelta: delta.no,
    });
  }

  return positionDeltas;
}

/**
 * Match a new order against the order book using price-time priority.
 *
 * Matching is atomic: all order book modifications succeed together or
 * the order book is rolled back to its previous state on failure.
 *
 * For BUY orders: Match against asks (sell orders) where ask.price <= buy.price
 * For SELL orders: Match against bids (buy orders) where bid.price >= sell.price
 *
 * The execution price is the maker's price (resting order's price).
 *
 * @param newOrder - The incoming order to match
 * @param orderBook - The order book to match against
 * @returns MatchResult containing trades, remaining order, and position deltas
 */
export function matchOrder(
  newOrder: MatchingOrder,
  orderBook: OrderBook,
  hooks: MatchHooks = {}
): MatchResult {
  const trades: Trade[] = [];
  const executedCommands: MatchCommand[] = [];
  let remainingQty = newOrder.quantity;
  const timestamp = Date.now();
  const matchingSide = newOrder.side === "BUY" ? "ask" : "bid";

  try {
    while (remainingQty > 0) {
      const bookOrder =
        matchingSide === "ask"
          ? orderBook.getBestAsk()
          : orderBook.getBestBid();

      if (!bookOrder) break;

      // Reject self-trade: skip the resting order if both sides have the same
      // userAddress (#703, #1455). The resting order is left untouched on the
      // book so it can match a later opponent.
      if (bookOrder.userAddress === newOrder.userAddress) {
        // If the best order is our own and its price can no longer match, no
        // further order at this or worse price levels can match either, so
        // stop to avoid spinning forever on a book of only our own orders.
        if (!canMatch(newOrder.price, bookOrder.price, newOrder.side)) {
          break;
        }

        // Skip past our own order without removing it. If the book has no
        // other order from a different user that can match, stop matching.
        const nextOrder = orderBook.getNextMatchableOrder(
          newOrder.userAddress,
          newOrder.price,
          newOrder.side
        );

        if (!nextOrder) break;

        // Match against the next cross-user order directly.
        const fillQty = Math.min(remainingQty, nextOrder.quantity);
        const executionPrice = nextOrder.price;

        const trade = createTrade(
          newOrder,
          nextOrder,
          fillQty,
          executionPrice,
          timestamp
        );
        trades.push(trade);
        hooks.onTradeFilled?.(trade);

        const newBookOrderQty = nextOrder.quantity - fillQty;
        let cmd: MatchCommand;

        if (newBookOrderQty === 0) {
          cmd = new RemoveOrderCommand(orderBook, nextOrder.id);
        } else {
          cmd = new UpdateQuantityCommand(
            orderBook,
            nextOrder.id,
            newBookOrderQty,
            nextOrder.quantity
          );
        }

        cmd.execute();
        executedCommands.push(cmd);

        remainingQty -= fillQty;
        continue;
      }

      if (!canMatch(newOrder.price, bookOrder.price, newOrder.side)) {
        break;
      }

      const fillQty = Math.min(remainingQty, bookOrder.quantity);
      const executionPrice = bookOrder.price;

      const trade = createTrade(
        newOrder,
        bookOrder,
        fillQty,
        executionPrice,
        timestamp
      );
      trades.push(trade);
      hooks.onTradeFilled?.(trade);

      const newBookOrderQty = bookOrder.quantity - fillQty;
      let cmd: MatchCommand;

      if (newBookOrderQty === 0) {
        cmd = new RemoveOrderCommand(orderBook, bookOrder.id);
      } else {
        cmd = new UpdateQuantityCommand(
          orderBook,
          bookOrder.id,
          newBookOrderQty,
          bookOrder.quantity
        );
      }

      cmd.execute();
      executedCommands.push(cmd);

      remainingQty -= fillQty;
    }
  } catch (error) {
    rollbackCommands(executedCommands);
    throw error;
  }

  const remainingOrder =
    remainingQty > 0 ? { ...newOrder, quantity: remainingQty } : null;

  const positionDeltas = calculatePositionDeltas(trades);

  return { trades, remainingOrder, positionDeltas };
}

export { outcomeToNumber };
