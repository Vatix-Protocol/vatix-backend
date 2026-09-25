import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type {
  RawChainEvent,
  NormalizedResolution,
  ResolutionOutcome,
} from "./types.js";
import { ResolutionParseError } from "./types.js";
import type { Telemetry } from "./telemetry.js";

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

/** scValToNative often yields bigint for u32/u64; coerce to a finite number. */
function toConfidenceScore(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") {
    const asNumber = Number(value);
    return Number.isFinite(asNumber) ? asNumber : null;
  }
  return null;
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
  confidenceScore: number | null;
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
 * Legacy payload shapes (ScvVec tuple, legacy ScvMap) predate the real
 * on-chain `MarketResolvedEvent` layout and were only ever needed to decode
 * fixtures from local devnet stubs. Accepting them in production means a
 * misconfigured or downgraded contract can silently produce
 * `ResolutionCandidate` rows with an empty/garbage `oracleAddress` instead
 * of failing the batch — see the issue this const documents. Threaded
 * through from `parseResolutionEvent`/`parseResolutionEvents`, defaulting
 * to `process.env.NODE_ENV` so callers never need to pass it explicitly in
 * real deployments.
 */
export function isProductionEnv(nodeEnv: string): boolean {
  return nodeEnv === "production";
}

/**
 * Supports three payload shapes:
 *   - Real on-chain (topics[1]=market_id: u32, value=ScvMap{outcome, resolved_at})
 *   - Legacy ScvVec tuple (value=[market_id, outcome, resolved_at]) — dev/test stub only
 *   - Legacy ScvMap (value={ market_id, outcome, oracle }) — dev/test stub only
 *
 * In production (`nodeEnv === "production"`) the two legacy shapes throw
 * instead of being silently accepted, so a contract/topic drift never
 * results in a resolution being dropped or mis-attributed off-chain.
 */
function parseResolutionPayload(
  decoded: unknown,
  topicsXdr: string[],
  eventId: string,
  nodeEnv: string
): ResolutionPayload {
  if (Array.isArray(decoded)) {
    if (isProductionEnv(nodeEnv)) {
      throw new ResolutionParseError(
        "Legacy ScvVec tuple resolution payload is not permitted in production — " +
          "the contract must emit the canonical MarketResolvedEvent shape " +
          "(topics[1]=market_id, value={outcome, resolved_at})",
        eventId
      );
    }
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
      confidenceScore: null,
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
    if (isProductionEnv(nodeEnv)) {
      throw new ResolutionParseError(
        "Legacy ScvMap resolution payload is not permitted in production — " +
          "the contract must emit the canonical MarketResolvedEvent shape " +
          "(topics[1]=market_id, value={outcome, resolved_at})",
        eventId
      );
    }
    // Legacy ScvMap payload: market_id, outcome, and oracle all in the value.
    const oracleAddress = map.oracle != null ? String(map.oracle) : "";
    if (oracleAddress === "") {
      throw new ResolutionParseError('Missing field "oracle"', eventId);
    }
    const confidenceScore = toConfidenceScore(map.confidence);
    return {
      marketId: String(field(map, "market_id", eventId)),
      outcome: toResolutionOutcome(field(map, "outcome", eventId), eventId),
      oracleAddress,
      confidenceScore,
    };
  }

  // Real on-chain shape: MarketResolvedEvent { #[topic] market_id: u32,
  // outcome: bool, resolved_at: u64 }. market_id arrives via topics[1], not
  // the value map. The contract does not publish an oracle address on this
  // event, so oracleAddress is left empty pending reconciliation.
  const confidenceScore = toConfidenceScore(map.confidence);
  return {
    marketId: marketIdFromTopic(topicsXdr, eventId),
    outcome: toResolutionOutcome(field(map, "outcome", eventId), eventId),
    oracleAddress: "",
    confidenceScore,
  };
}

export interface ParseResolutionEventOptions {
  telemetry?: Telemetry;
  /** Defaults to `process.env.NODE_ENV`; override in tests only. */
  nodeEnv?: string;
}

/**
 * Parse a single RawChainEvent into a NormalizedResolution.
 *
 * @throws ResolutionParseError if the event is not a resolution event, the
 *   payload is malformed, or (in production) the payload uses a legacy
 *   dev-stub shape instead of the canonical on-chain layout.
 */
export function parseResolutionEvent(
  event: RawChainEvent,
  options?: ParseResolutionEventOptions
): NormalizedResolution {
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV ?? "development";

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

  let payload: ResolutionPayload;
  try {
    payload = parseResolutionPayload(decoded, event.topicsXdr, event.id, nodeEnv);
  } catch (err) {
    if (isProductionEnv(nodeEnv)) {
      options?.telemetry?.record("indexer.parser.legacy_shape_rejected", 1, {
        parser: "resolution",
        eventId: event.id,
        contractId: event.contractId,
        ledger: String(event.ledger),
      });
    }
    throw err;
  }

  return {
    eventId: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
    marketId: payload.marketId,
    outcome: payload.outcome,
    oracleAddress: payload.oracleAddress,
    confidenceScore: payload.confidenceScore,
  };
}

/**
 * Parse a batch of raw events, skipping non-resolution events silently.
 * Errors are collected per-event so one bad payload never drops the batch.
 */
export function parseResolutionEvents(
  events: RawChainEvent[],
  options?: ParseResolutionEventOptions
): {
  resolutions: NormalizedResolution[];
  errors: ResolutionParseError[];
} {
  const resolutions: NormalizedResolution[] = [];
  const errors: ResolutionParseError[] = [];
  const telemetry = options?.telemetry;
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV ?? "development";

  for (const event of events) {
    if (!isResolutionEvent(event.topicsXdr)) {
      telemetry?.record("indexer.parser.unknown_topics", 1, {
        parser: "resolution",
        eventId: event.id,
        contractId: event.contractId,
        ledger: String(event.ledger),
      });
      continue;
    }
    try {
      resolutions.push(parseResolutionEvent(event, { telemetry, nodeEnv }));
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
