import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type {
  RawChainEvent,
  NormalizedTrade,
  TradeDirection,
  TradeOutcome,
} from "./types.js";
import { TradeParseError } from "./types.js";
import type { Telemetry } from "./telemetry.js";

/**
 * Topic index 0 carries the event name symbol. Soroban's #[contractevent]
 * macro derives that symbol by snake_casing the event struct name,
 * including its literal "Event" suffix — every event currently published
 * by contracts/market/src/events.rs follows this pattern (e.g.
 * MarketCreatedEvent -> "market_created_event", MarketResolvedEvent ->
 * "market_resolved_event"). The contract does not yet publish a trade
 * execution event (trades are matched off-chain by the CLOB; see the
 * Trade/IndexedTrade Prisma models), so this discriminator anticipates
 * the eventual TradeExecutedEvent using that same convention rather than
 * the unsuffixed "trade_executed" guess this previously used.
 */
const TRADE_EVENT_TOPIC = "trade_executed_event";

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
 * `Order.id` in `prisma/schema.prisma` is `@default(uuid())` — every CLOB
 * order the matching engine creates has a UUID id. A settle_trade event
 * carrying a `buy_order_id`/`sell_order_id` that isn't a UUID can never
 * join back to a real `Order` row, which previously meant the trade was
 * still written with an unjoinable order id instead of failing the batch.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read and validate a CLOB order-id field.
 *
 * Always rejects empty/blank values (never joins to a real order in any
 * environment). In production, also requires the id to match the UUID
 * shape `Order.id` actually uses — non-UUID values only ever arise from
 * local/dev fixtures — so a fill that can't be joined to a CLOB Order
 * fails fast instead of being silently persisted unlinked.
 */
function toOrderId(
  map: Record<string, unknown>,
  key: string,
  eventId: string,
  nodeEnv: string
): string {
  const raw = String(field(map, key, eventId)).trim();
  if (raw === "") {
    throw new TradeParseError(`Field "${key}" must not be empty`, eventId);
  }
  if (isProductionEnv(nodeEnv) && !UUID_RE.test(raw)) {
    throw new TradeParseError(
      `Field "${key}" ("${raw}") is not a valid CLOB Order id (UUID) — ` +
        "cannot join this fill to an Order in production",
      eventId
    );
  }
  return raw;
}

/** Mirrors resolutionParser.isProductionEnv — kept local to avoid a cross-parser import. */
function isProductionEnv(nodeEnv: string): boolean {
  return nodeEnv === "production";
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
 * @throws TradeParseError if the event is not a trade event, the payload is
 *   malformed, or (in production) `buy_order_id`/`sell_order_id` cannot be
 *   joined to a real CLOB `Order` row.
 */
export interface ParseTradeEventOptions {
  telemetry?: Telemetry;
  /** Defaults to `process.env.NODE_ENV`; override in tests only. */
  nodeEnv?: string;
}

export function parseTradeEvent(
  event: RawChainEvent,
  options?: ParseTradeEventOptions
): NormalizedTrade {
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV ?? "development";

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
    buyOrderId: toOrderId(map, "buy_order_id", event.id, nodeEnv),
    sellOrderId: toOrderId(map, "sell_order_id", event.id, nodeEnv),
  };
}

/**
 * Parse a batch of raw events, skipping non-trade events silently.
 * Returns successfully parsed trades and collects errors separately
 * so one bad event never drops the whole batch.
 */
export function parseTradeEvents(
  events: RawChainEvent[],
  options?: ParseTradeEventOptions
): {
  trades: NormalizedTrade[];
  errors: TradeParseError[];
} {
  const trades: NormalizedTrade[] = [];
  const errors: TradeParseError[] = [];
  const telemetry = options?.telemetry;
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV ?? "development";

  for (const event of events) {
    if (!isTradeEvent(event.topicsXdr)) {
      telemetry?.record("indexer.parser.unknown_topics", 1, {
        parser: "trade",
        eventId: event.id,
        contractId: event.contractId,
        ledger: String(event.ledger),
      });
      continue;
    }
    try {
      trades.push(parseTradeEvent(event, { telemetry, nodeEnv }));
    } catch (err) {
      if (isProductionEnv(nodeEnv)) {
        telemetry?.record("indexer.parser.unjoinable_order_id", 1, {
          parser: "trade",
          eventId: event.id,
          contractId: event.contractId,
          ledger: String(event.ledger),
        });
      }
      errors.push(
        err instanceof TradeParseError
          ? err
          : new TradeParseError(String(err), event.id, err)
      );
    }
  }

  return { trades, errors };
}
