import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type {
  RawChainEvent,
  NormalizedTrade,
  TradeDirection,
  TradeOutcome,
} from "./types.js";
import { TradeParseError } from "./types.js";

/**
 * Topic index 0 carries the event name symbol, e.g. "trade_executed".
 * We only parse events with this exact discriminator.
 */
const TRADE_EVENT_TOPIC = "trade_executed";

/**
 * Decode a base64-encoded XDR ScVal into its native JS representation.
 * Returns a plain object/map for ScvMap values.
 */
function decodeScVal(xdrBase64: string): unknown {
  const val = xdr.ScVal.fromXDR(xdrBase64, "base64");
  return scValToNative(val);
}

/**
 * Safely read a field from a decoded ScVal map (plain object).
 * Throws TradeParseError when the field is missing.
 */
function field<T>(
  map: Record<string, unknown>,
  key: string,
  eventId: string
): T {
  if (!(key in map)) {
    throw new TradeParseError(`Missing field "${key}"`, eventId);
  }
  return map[key] as T;
}

/**
 * Convert a value that may be bigint, number, or string to bigint.
 * Throws TradeParseError on values that cannot be safely represented.
 */
function toBigInt(value: unknown, fieldName: string, eventId: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new TradeParseError(
        `Field "${fieldName}" is a non-integer number — precision loss risk`,
        eventId
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      throw new TradeParseError(
        `Field "${fieldName}" cannot be parsed as bigint: ${value}`,
        eventId
      );
    }
  }
  throw new TradeParseError(
    `Field "${fieldName}" has unexpected type ${typeof value}`,
    eventId
  );
}

function toTradeOutcome(value: unknown, eventId: string): TradeOutcome {
  if (value === "YES" || value === "NO") return value;
  throw new TradeParseError(`Invalid outcome value: ${String(value)}`, eventId);
}

function toDirection(value: unknown, eventId: string): TradeDirection {
  const v = String(value).toLowerCase();
  if (v === "buy" || v === "sell") return v;
  throw new TradeParseError(
    `Invalid direction value: ${String(value)}`,
    eventId
  );
}

/**
 * Determine whether the first topic XDR matches the trade_executed discriminator.
 */
function isTradeEvent(topicsXdr: string[]): boolean {
  if (topicsXdr.length === 0) return false;
  try {
    const topic = decodeScVal(topicsXdr[0]);
    return topic === TRADE_EVENT_TOPIC;
  } catch {
    return false;
  }
}

/**
 * Parse a single RawChainEvent into a NormalizedTrade.
 *
 * Contract event value is expected to be an ScvMap with keys:
 *   market_id, trader, counterparty, direction, outcome,
 *   price, quantity, buy_order_id, sell_order_id
 *
 * @throws TradeParseError if the event is not a trade event or the payload is malformed
 */
export function parseTradeEvent(event: RawChainEvent): NormalizedTrade {
  if (!isTradeEvent(event.topicsXdr)) {
    throw new TradeParseError(
      `Event topic is not "${TRADE_EVENT_TOPIC}"`,
      event.id
    );
  }

  let decoded: unknown;
  try {
    decoded = decodeScVal(event.valueXdr);
  } catch (err) {
    throw new TradeParseError(
      "Failed to decode event value XDR",
      event.id,
      err
    );
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new TradeParseError("Event value is not an ScvMap", event.id);
  }

  const map = decoded as Record<string, unknown>;

  return {
    eventId: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    marketId: String(field(map, "market_id", event.id)),
    traderAddress: String(field(map, "trader", event.id)),
    counterpartyAddress: String(field(map, "counterparty", event.id)),
    direction: toDirection(field(map, "direction", event.id), event.id),
    outcome: toTradeOutcome(field(map, "outcome", event.id), event.id),
    priceRaw: toBigInt(field(map, "price", event.id), "price", event.id),
    quantityRaw: toBigInt(
      field(map, "quantity", event.id),
      "quantity",
      event.id
    ),
    buyOrderId: String(field(map, "buy_order_id", event.id)),
    sellOrderId: String(field(map, "sell_order_id", event.id)),
  };
}

/**
 * Parse a batch of raw events, skipping non-trade events silently.
 * Returns successfully parsed trades and collects errors separately
 * so one bad event never drops the whole batch.
 */
export function parseTradeEvents(events: RawChainEvent[]): {
  trades: NormalizedTrade[];
  errors: TradeParseError[];
} {
  const trades: NormalizedTrade[] = [];
  const errors: TradeParseError[] = [];

  for (const event of events) {
    if (!isTradeEvent(event.topicsXdr)) continue;
    try {
      trades.push(parseTradeEvent(event));
    } catch (err) {
      errors.push(
        err instanceof TradeParseError
          ? err
          : new TradeParseError(String(err), event.id, err)
      );
    }
  }

  return { trades, errors };
}
