import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type {
  RawChainEvent,
  NormalizedResolution,
  ResolutionOutcome,
} from "./types.js";
import { ResolutionParseError } from "./types.js";

const RESOLUTION_EVENT_TOPIC = "market_resolved";

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

/**
 * Supports both legacy ScvMap payloads ({ market_id, outcome, oracle })
 * and the on-chain tuple (market_id: u32, outcome: bool, resolved_at: u64).
 */
function parseResolutionPayload(
  decoded: unknown,
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

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new ResolutionParseError(
      "Event value is not an ScvMap or tuple",
      eventId
    );
  }

  const map = decoded as Record<string, unknown>;

  return {
    marketId: String(field(map, "market_id", eventId)),
    outcome: toResolutionOutcome(field(map, "outcome", eventId), eventId),
    oracleAddress: map.oracle != null ? String(map.oracle) : "",
  };
}

/**
 * Parse a single RawChainEvent into a NormalizedResolution.
 *
 * Contract event value may be:
 *   - ScvMap: market_id, outcome (YES/NO), oracle
 *   - Tuple:  (market_id: u32, outcome: bool, resolved_at: u64)
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

  const payload = parseResolutionPayload(decoded, event.id);

  if (payload.oracleAddress === "" && !Array.isArray(decoded)) {
    throw new ResolutionParseError('Missing field "oracle"', event.id);
  }

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
