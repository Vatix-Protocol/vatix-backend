import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type { RawChainEvent } from "./types.js";
import { MarketCreatedParseError } from "./types.js";
import type { NormalizedMarketCreated } from "./types.js";
import type { Telemetry } from "./telemetry.js";

/**
 * Soroban's #[contractevent] macro derives the topic symbol by snake_casing
 * the event struct name, including its literal "Event" suffix — so
 * MarketCreatedEvent (contracts/market/src/events.rs) publishes under
 * "market_created_event", not "market_created".
 */
const MARKET_CREATED_TOPIC = "market_created_event";

/**
 * Hard cap on `question` length, matching the on-chain contract's
 * `MAX_QUESTION_LEN` (contracts/market/src/lib.rs) which rejects
 * MarketCreated submissions with a longer question string. The indexer must
 * reject — not silently truncate — any payload that exceeds this, otherwise
 * the off-chain `markets.question` column would desync from what the chain
 * actually stored/validated, corrupting UI display and any downstream
 * consumer that assumes indexer state mirrors chain state 1:1.
 */
const MAX_QUESTION_LENGTH = 499;

/**
 * Stable error codes for MarketCreated parsing. These are part of the
 * parser's public contract: downstream consumers (indexer pipeline, ops
 * dashboards, alerting) key off these codes, so they must not change
 * without a coordinated migration.
 */
export const MarketCreatedErrorCode = {
  WRONG_TOPIC: "MARKET_CREATED_WRONG_TOPIC",
  MISSING_MARKET_ID: "MARKET_CREATED_MISSING_MARKET_ID",
  BAD_MARKET_ID_XDR: "MARKET_CREATED_BAD_MARKET_ID_XDR",
  BAD_VALUE_XDR: "MARKET_CREATED_BAD_VALUE_XDR",
  VALUE_NOT_MAP: "MARKET_CREATED_VALUE_NOT_MAP",
  MISSING_QUESTION: "MARKET_CREATED_MISSING_QUESTION",
  BAD_END_TIME: "MARKET_CREATED_BAD_END_TIME",
} as const;

export type MarketCreatedErrorCode =
  (typeof MarketCreatedErrorCode)[keyof typeof MarketCreatedErrorCode];

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

/**
 * Converts a Unix timestamp (seconds) or ISO-8601 string to an ISO-8601 string.
 * Fails closed: any value that cannot be unambiguously interpreted as a
 * timestamp throws rather than silently defaulting.
 */
function toIsoEndTime(raw: unknown, eventId: string): string {
  if (typeof raw === "bigint") {
    return new Date(Number(raw) * 1000).toISOString();
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new MarketCreatedParseError(
        `Invalid or missing "end_time": ${JSON.stringify(raw)}`,
        eventId,
        undefined,
        MarketCreatedErrorCode.BAD_END_TIME
      );
    }
    return new Date(raw * 1000).toISOString();
  }
  if (typeof raw === "string") {
    const parsed = /^\d+$/.test(raw)
      ? new Date(Number(raw) * 1000)
      : new Date(raw);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  throw new MarketCreatedParseError(
    `Invalid or missing "end_time": ${JSON.stringify(raw)}`,
    eventId,
    undefined,
    MarketCreatedErrorCode.BAD_END_TIME
  );
}

/**
 * Parse a single RawChainEvent into a NormalizedMarketCreated.
 *
 * On-chain shape (MarketCreatedEvent in contracts/market/src/events.rs):
 *   topics: [market_created_event, market_id: u32]
 *   value (ScvMap): { question: String, end_time: u64 }
 *
 * The contract does not publish oracle_address or status on this event —
 * the oracle pubkey is stored on-chain but not republished here, and every
 * newly created market starts ACTIVE — so oracleAddress is left empty
 * pending reconciliation and status defaults to "ACTIVE".
 *
 * @throws MarketCreatedParseError on wrong topic or malformed payload.
 */
export function parseMarketCreatedChainEvent(
  event: RawChainEvent
): NormalizedMarketCreated {
  if (!isMarketCreatedEvent(event.topicsXdr)) {
    throw new MarketCreatedParseError(
      `Event topic is not "${MARKET_CREATED_TOPIC}"`,
      event.id,
      undefined,
      MarketCreatedErrorCode.WRONG_TOPIC
    );
  }

  if (event.topicsXdr.length < 2) {
    throw new MarketCreatedParseError(
      "Missing market_id topic",
      event.id,
      undefined,
      MarketCreatedErrorCode.MISSING_MARKET_ID
    );
  }

  let marketIdRaw: unknown;
  try {
    marketIdRaw = decodeScVal(event.topicsXdr[1]);
  } catch (err) {
    throw new MarketCreatedParseError(
      "Failed to decode market_id topic XDR",
      event.id,
      err,
      MarketCreatedErrorCode.BAD_MARKET_ID_XDR
    );
  }

  if (
    typeof marketIdRaw !== "number" &&
    typeof marketIdRaw !== "bigint" &&
    typeof marketIdRaw !== "string"
  ) {
    throw new MarketCreatedParseError(
      `Invalid market_id topic: ${JSON.stringify(marketIdRaw)}`,
      event.id,
      undefined,
      MarketCreatedErrorCode.MISSING_MARKET_ID
    );
  }

  let decoded: unknown;
  try {
    decoded = decodeScVal(event.valueXdr);
  } catch (err) {
    throw new MarketCreatedParseError(
      "Failed to decode event value XDR",
      event.id,
      err,
      MarketCreatedErrorCode.BAD_VALUE_XDR
    );
  }

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new MarketCreatedParseError(
      "Event value is not an ScvMap",
      event.id,
      undefined,
      MarketCreatedErrorCode.VALUE_NOT_MAP
    );
  }

  const map = decoded as Record<string, unknown>;
  const question = String(map.question ?? "");

  // Fail loudly rather than truncate (#986-style silent desync): a
  // question longer than the contract allows means either the contract's
  // cap changed without this constant being updated, or the event was
  // mis-decoded — either way, storing a truncated question would silently
  // diverge from on-chain state instead of surfacing the mismatch.
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new MarketCreatedParseError(
      `question exceeds max length of ${MAX_QUESTION_LENGTH} chars (got ${question.length}): contract cap may have changed`,
      event.id
    );
  }

  if (typeof map.question !== "string" || map.question.length === 0) {
    throw new MarketCreatedParseError(
      `Invalid or missing "question": ${JSON.stringify(map.question)}`,
      event.id,
      undefined,
      MarketCreatedErrorCode.MISSING_QUESTION
    );
  }

  return {
    eventId: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    marketId: String(marketIdRaw),
    question,
    endTime: toIsoEndTime(map.end_time, event.id),
    oracleAddress: "",
    status: "ACTIVE",
  };
}

/**
 * Parse a batch of raw events, skipping non-market-created events silently.
 * Errors are collected per-event so one bad payload never drops the batch.
 *
 * Idempotency: the same MarketCreated event may be replayed (retries,
 * overlapping ledger ranges, reorg re-delivery). We dedupe on the stable
 * (ledger, eventIndex) identity so downstream writers see each market
 * exactly once. The first occurrence wins; later duplicates are dropped
 * silently rather than surfaced as errors.
 */
export function parseMarketCreatedEvents(
  events: RawChainEvent[],
  options?: { telemetry?: Telemetry }
): {
  markets: NormalizedMarketCreated[];
  errors: MarketCreatedParseError[];
} {
  const markets: NormalizedMarketCreated[] = [];
  const errors: MarketCreatedParseError[] = [];
  const seen = new Set<string>();
  const telemetry = options?.telemetry;

  for (const event of events) {
    if (!isMarketCreatedEvent(event.topicsXdr)) {
      telemetry?.record("indexer.parser.unknown_topics", 1, {
        parser: "market_created",
        eventId: event.id,
        contractId: event.contractId,
        ledger: String(event.ledger),
      });
      continue;
    }

    const dedupeKey = `${event.ledger}:${event.eventIndex}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    try {
      markets.push(parseMarketCreatedChainEvent(event));
    } catch (err) {
      errors.push(
        err instanceof MarketCreatedParseError
          ? err
          : new MarketCreatedParseError(
              String(err),
              event.id,
              err,
              MarketCreatedErrorCode.BAD_VALUE_XDR
            )
      );
    }
  }

  return { markets, errors };
}
