import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type {
  RawChainEvent,
  NormalizedResolution,
  ResolutionOutcome,
} from "./types.js";
import { ResolutionParseError } from "./types.js";

/**
 * Soroban's #[contractevent] macro derives the topic symbol by snake_casing
 * the event struct name, including its literal "Event" suffix — so
 * MarketResolvedEvent (contracts/market/src/events.rs) publishes under
 * "market_resolved_event", not "market_resolved".
 */
const RESOLUTION_EVENT_TOPIC = "market_resolved_event";

function decodeScVal(xdrBase64: string): unknown {
  const val = xdr.ScVal.fromXDR(xdrBase64, "base64");
  return scValToNative(val);
}

function field<T>(
  map: Record<string, unknown>,
  key: string,
  eventId: string
): T {
  if (!(key in map)) {
    throw new ResolutionParseError(`Missing field "${key}"`, eventId);
  }
  return map[key] as T;
}

function toResolutionOutcome(
  value: unknown,
  eventId: string
): ResolutionOutcome {
  if (value === "YES" || value === "NO") return value;
  if (value === true) return "YES";
  if (value === false) return "NO";
  throw new ResolutionParseError(
    `Unknown resolution outcome: "${String(value)}" — must be YES/NO or boolean`,
    eventId
  );
}

function isResolutionEvent(topicsXdr: string[]): boolean {
  if (topicsXdr.length === 0) return false;
  try {
    return decodeScVal(topicsXdr[0]) === RESOLUTION_EVENT_TOPIC;
  } catch {
    return false;
  }
}

interface ResolutionPayload {
  marketId: string;
  outcome: ResolutionOutcome;
  oracleAddress: string;
}

function marketIdFromTopic(topicsXdr: string[], eventId: string): string {
  if (topicsXdr.length < 2) {
    throw new ResolutionParseError("Missing market_id topic", eventId);
  }
  try {
    return String(decodeScVal(topicsXdr[1]));
  } catch (err) {
    throw new ResolutionParseError(
      "Failed to decode market_id topic XDR",
      eventId,
      err
    );
  }
}

/**
 * Supports three payload shapes:
 *   - Real on-chain (topics[1]=market_id: u32, value=ScvMap{outcome, resolved_at})
 *   - Legacy ScvVec tuple (value=[market_id, outcome, resolved_at])
 *   - Legacy ScvMap (value={ market_id, outcome, oracle })
 */
function parseResolutionPayload(
  decoded: unknown,
  topicsXdr: string[],
  eventId: string
): ResolutionPayload {
  if (Array.isArray(decoded)) {
    if (decoded.length < 2) {
      throw new ResolutionParseError(
        "Tuple resolution payload must include market_id and outcome",
        eventId
      );
    }

    return {
      marketId: String(decoded[0]),
      outcome: toResolutionOutcome(decoded[1], eventId),
      oracleAddress: "",
    };
  }

  if (typeof decoded !== "object" || decoded === null) {
    throw new ResolutionParseError(
      "Event value is not an ScvMap or tuple",
      eventId
    );
  }

  const map = decoded as Record<string, unknown>;

  if ("market_id" in map) {
    // Legacy ScvMap payload: market_id, outcome, and oracle all in the value.
    const oracleAddress = map.oracle != null ? String(map.oracle) : "";
    if (oracleAddress === "") {
      throw new ResolutionParseError('Missing field "oracle"', eventId);
    }
    return {
      marketId: String(field(map, "market_id", eventId)),
      outcome: toResolutionOutcome(field(map, "outcome", eventId), eventId),
      oracleAddress,
    };
  }

  // Real on-chain shape: MarketResolvedEvent { #[topic] market_id: u32,
  // outcome: bool, resolved_at: u64 }. market_id arrives via topics[1], not
  // the value map. The contract does not publish an oracle address on this
  // event, so oracleAddress is left empty pending reconciliation.
  return {
    marketId: marketIdFromTopic(topicsXdr, eventId),
    outcome: toResolutionOutcome(field(map, "outcome", eventId), eventId),
    oracleAddress: "",
  };
}

/**
 * Parse a single RawChainEvent into a NormalizedResolution.
 *
 * @throws ResolutionParseError if the event is not a resolution event or payload is malformed
 */
export function parseResolutionEvent(
  event: RawChainEvent
): NormalizedResolution {
  if (!isResolutionEvent(event.topicsXdr)) {
    throw new ResolutionParseError(
      `Event topic is not "${RESOLUTION_EVENT_TOPIC}"`,
      event.id
    );
  }

  let decoded: unknown;
  try {
    decoded = decodeScVal(event.valueXdr);
  } catch (err) {
    throw new ResolutionParseError(
      "Failed to decode event value XDR",
      event.id,
      err
    );
  }

  const payload = parseResolutionPayload(decoded, event.topicsXdr, event.id);

  return {
    eventId: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    marketId: payload.marketId,
    outcome: payload.outcome,
    oracleAddress: payload.oracleAddress,
  };
}

/**
 * Parse a batch of raw events, skipping non-resolution events silently.
 * Errors are collected per-event so one bad payload never drops the batch.
 */
export function parseResolutionEvents(events: RawChainEvent[]): {
  resolutions: NormalizedResolution[];
  errors: ResolutionParseError[];
} {
  const resolutions: NormalizedResolution[] = [];
  const errors: ResolutionParseError[] = [];

  for (const event of events) {
    if (!isResolutionEvent(event.topicsXdr)) continue;
    try {
      resolutions.push(parseResolutionEvent(event));
    } catch (err) {
      errors.push(
        err instanceof ResolutionParseError
          ? err
          : new ResolutionParseError(String(err), event.id, err)
      );
    }
  }

  return { resolutions, errors };
}
