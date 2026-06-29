import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { RawChainEvent } from "./types.js";
import { MarketCreatedParseError } from "./types.js";
import type { NormalizedMarketCreated } from "./types.js";
import { parseMarketCreatedEvent } from "../market-created-parser.js";

const MARKET_CREATED_TOPIC = "market_created";

function decodeScVal(xdrBase64: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(xdrBase64, "base64"));
}

function isMarketCreatedEvent(topicsXdr: string[]): boolean {
  if (topicsXdr.length === 0) return false;
  try {
    return decodeScVal(topicsXdr[0]) === MARKET_CREATED_TOPIC;
  } catch {
    return false;
  }
}

function normalizeEndTime(raw: unknown): number | string | undefined {
  if (typeof raw === "bigint") return Number(raw);
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return raw;
  return undefined;
}

/**
 * Parse a single RawChainEvent into a NormalizedMarketCreated.
 *
 * Expected on-chain value: ScvMap {
 *   market_id: str, question: str, end_time: u64,
 *   oracle_address: str, status: str
 * }
 *
 * @throws MarketCreatedParseError on wrong topic or malformed payload.
 */
export function parseMarketCreatedChainEvent(
  event: RawChainEvent
): NormalizedMarketCreated {
  if (!isMarketCreatedEvent(event.topicsXdr)) {
    throw new MarketCreatedParseError(
      `Event topic is not "${MARKET_CREATED_TOPIC}"`,
      event.id
    );
  }

  let decoded: unknown;
  try {
    decoded = decodeScVal(event.valueXdr);
  } catch (err) {
    throw new MarketCreatedParseError(
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
    throw new MarketCreatedParseError("Event value is not an ScvMap", event.id);
  }

  const map = decoded as Record<string, unknown>;

  const rawEvent = {
    id:
      typeof map.market_id === "string"
        ? map.market_id
        : String(map.market_id ?? ""),
    question: typeof map.question === "string" ? map.question : undefined,
    endTime: normalizeEndTime(map.end_time),
    oracleAddress:
      typeof map.oracle_address === "string" ? map.oracle_address : undefined,
    status: typeof map.status === "string" ? map.status : undefined,
  };

  const result = parseMarketCreatedEvent(rawEvent);
  if (!result.success || !result.data) {
    throw new MarketCreatedParseError(
      result.error ?? "Unknown parse error",
      event.id
    );
  }

  return {
    eventId: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    marketId: result.data.id,
    question: result.data.question,
    endTime: result.data.endTime,
    oracleAddress: result.data.oracleAddress,
    status: result.data.status,
  };
}

/**
 * Parse a batch of raw events, skipping non-market-created events silently.
 */
export function parseMarketCreatedEvents(events: RawChainEvent[]): {
  markets: NormalizedMarketCreated[];
  errors: MarketCreatedParseError[];
} {
  const markets: NormalizedMarketCreated[] = [];
  const errors: MarketCreatedParseError[] = [];

  for (const event of events) {
    if (!isMarketCreatedEvent(event.topicsXdr)) continue;
    try {
      markets.push(parseMarketCreatedChainEvent(event));
    } catch (err) {
      errors.push(
        err instanceof MarketCreatedParseError
          ? err
          : new MarketCreatedParseError(String(err), event.id, err)
      );
    }
  }

  return { markets, errors };
}
