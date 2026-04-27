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
  throw new ResolutionParseError(
    `Unknown resolution outcome: "${String(value)}" — must be "YES" or "NO"`,
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

/**
 * Parse a single RawChainEvent into a NormalizedResolution.
 *
 * Contract event value is expected to be an ScvMap with keys:
 *   market_id, outcome, oracle
 *
 * The source ledger sequence is preserved in the returned record
 * as the authoritative timestamp for settlement ordering.
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

  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new ResolutionParseError("Event value is not an ScvMap", event.id);
  }

  const map = decoded as Record<string, unknown>;

  return {
    eventId: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    marketId: String(field(map, "market_id", event.id)),
    outcome: toResolutionOutcome(field(map, "outcome", event.id), event.id),
    oracleAddress: String(field(map, "oracle", event.id)),
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
