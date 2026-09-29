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

/**
 * Settlement events are emitted by the settlement contract once a resolved
 * market's positions are settled. They are indexed alongside resolution
 * events so downstream consumers can reconcile settlement state without
 * re-deriving it from resolution alone. The topic symbol follows the same
 * snake_case + "Event" suffix convention as resolution events.
 */
const SETTLEMENT_EVENT_TOPIC = "settlement_event";

/**
 * Stable error codes for Resolution parsing. These are part of the parser's
 * public contract: downstream consumers (indexer pipeline, ops dashboards,
 * alerting) key off these codes, so they must not change without a
 * coordinated migration.
 */
export const ResolutionErrorCode = {
  WRONG_TOPIC: "RESOLUTION_WRONG_TOPIC",
  BAD_VALUE_XDR: "RESOLUTION_BAD_VALUE_XDR",
  VALUE_NOT_MAP_OR_TUPLE: "RESOLUTION_VALUE_NOT_MAP_OR_TUPLE",
  MISSING_FIELD: "RESOLUTION_MISSING_FIELD",
  INVALID_OUTCOME: "RESOLUTION_INVALID_OUTCOME",
  MISSING_MARKET_ID: "RESOLUTION_MISSING_MARKET_ID",
  BAD_MARKET_ID_XDR: "RESOLUTION_BAD_MARKET_ID_XDR",
  LEGACY_SHAPE_REJECTED: "RESOLUTION_LEGACY_SHAPE_REJECTED",
  MISSING_ORACLE: "RESOLUTION_MISSING_ORACLE",
  BAD_CONFIDENCE: "RESOLUTION_BAD_CONFIDENCE",
  MISSING_SETTLEMENT_ID: "RESOLUTION_MISSING_SETTLEMENT_ID",
  BAD_SETTLEMENT_ID_XDR: "RESOLUTION_BAD_SETTLEMENT_ID_XDR",
  INVALID_SETTLEMENT_AMOUNT: "RESOLUTION_INVALID_SETTLEMENT_AMOUNT",
} as const;

export type ResolutionErrorCode =
  (typeof ResolutionErrorCode)[keyof typeof ResolutionErrorCode];

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
    throw new ResolutionParseError(
      `Missing field "${key}"`,
      eventId,
      undefined,
      ResolutionErrorCode.MISSING_FIELD
    );
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
    eventId,
    undefined,
    ResolutionErrorCode.INVALID_OUTCOME
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

/**
 * Coerce a settlement amount (i128/u64) to a finite number. Settlement
 * amounts are money-path values, so anything non-finite or negative is
 * rejected rather than silently coerced to 0.
 */
function toSettlementAmount(value: unknown, eventId: string): number {
  let asNumber: number;
  if (typeof value === "number") {
    asNumber = value;
  } else if (typeof value === "bigint") {
    asNumber = Number(value);
  } else {
    throw new ResolutionParseError(
      `Invalid settlement amount: "${String(value)}" — must be a number`,
      eventId,
      undefined,
      ResolutionErrorCode.INVALID_SETTLEMENT_AMOUNT
    );
  }
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    throw new ResolutionParseError(
      `Invalid settlement amount: "${String(value)}" — must be finite and non-negative`,
      eventId,
      undefined,
      ResolutionErrorCode.INVALID_SETTLEMENT_AMOUNT
    );
  }
  return asNumber;
}

function isResolutionEvent(topicsXdr: string[]): boolean {
  if (topicsXdr.length === 0) return false;
  try {
    return decodeScVal(topicsXdr[0]) === RESOLUTION_EVENT_TOPIC;
  } catch {
    return false;
  }
}

function isSettlementEvent(topicsXdr: string[]): boolean {
  if (topicsXdr.length === 0) return false;
  try {
    return decodeScVal(topicsXdr[0]) === SETTLEMENT_EVENT_TOPIC;
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
    throw new ResolutionParseError(
      "Missing market_id topic",
      eventId,
      undefined,
      ResolutionErrorCode.MISSING_MARKET_ID
    );
  }
  try {
    return String(decodeScVal(topicsXdr[1]));
  } catch (err) {
    throw new ResolutionParseError(
      "Failed to decode market_id topic XDR",
      eventId,
      err,
      ResolutionErrorCode.BAD_MARKET_ID_XDR
    );
  }
}

/**
 * Settlement events carry the settlement id as topics[1] (mirroring how
 * resolution events carry market_id), so downstream consumers can key
 * idempotently on a stable on-chain identifier.
 */
function settlementIdFromTopic(topicsXdr: string[], eventId: string): string {
  if (topicsXdr.length < 2) {
    throw new ResolutionParseError(
      "Missing settlement_id topic",
      eventId,
      undefined,
      ResolutionErrorCode.MISSING_SETTLEMENT_ID
    );
  }
  try {
    return String(decodeScVal(topicsXdr[1]));
  } catch (err) {
    throw new ResolutionParseError(
      "Failed to decode settlement_id topic XDR",
      eventId,
      err,
      ResolutionErrorCode.BAD_SETTLEMENT_ID_XDR
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
        eventId,
        undefined,
        ResolutionErrorCode.LEGACY_SHAPE_REJECTED
      );
    }
    if (decoded.length < 2) {
      throw new ResolutionParseError(
        "Tuple resolution payload must include market_id and outcome",
        eventId,
        undefined,
        ResolutionErrorCode.MISSING_FIELD
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
      eventId,
      undefined,
      ResolutionErrorCode.VALUE_NOT_MAP_OR_TUPLE
    );
  }

  const map = decoded as Record<string, unknown>;

  if ("market_id" in map) {
    if (isProductionEnv(nodeEnv)) {
      throw new ResolutionParseError(
        "Legacy ScvMap resolution payload is not permitted in production — " +
          "the contract must emit the canonical MarketResolvedEvent shape " +
          "(topics[1]=market_id, value={outcome, resolved_at})",
        eventId,
        undefined,
        ResolutionErrorCode.LEGACY_SHAPE_REJECTED
      );
    }
    // Legacy ScvMap payload: market_id, outcome, and oracle all in the value.
    const oracleAddress = map.oracle != null ? String(map.oracle) : "";
    if (oracleAddress === "") {
      throw new ResolutionParseError(
        'Missing field "oracle"',
        eventId,
        undefined,
        ResolutionErrorCode.MISSING_ORACLE
      );
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

/**
 * Settlement payload shape: SettlementEvent { #[topic] settlement_id: u64,
 * market_id: u32, amount: i128, settled_at: u64 }. settlement_id arrives via
 * topics[1]; the remaining fields live in the value map. Legacy tuple/map
 * shapes are rejected in production for the same reason as resolution
 * payloads — a contract/topic drift must fail the batch, not silently
 * produce a settlement row with a garbage id.
 */
function parseSettlementPayload(
  decoded: unknown,
  topicsXdr: string[],
  eventId: string,
  nodeEnv: string
): NormalizedResolution {
  if (Array.isArray(decoded)) {
    if (isProductionEnv(nodeEnv)) {
      throw new ResolutionParseError(
        "Legacy ScvVec tuple settlement payload is not permitted in production — " +
          "the contract must emit the canonical SettlementEvent shape " +
          "(topics[1]=settlement_id, value={market_id, amount, settled_at})",
        eventId,
        undefined,
        ResolutionErrorCode.LEGACY_SHAPE_REJECTED
      );
    }
    if (decoded.length < 3) {
      throw new ResolutionParseError(
        "Tuple settlement payload must include settlement_id, market_id and amount",
        eventId,
        undefined,
        ResolutionErrorCode.MISSING_FIELD
      );
    }
    return {
      marketId: String(decoded[1]),
      outcome: toResolutionOutcome(decoded[2], eventId),
      oracleAddress: "",
      confidenceScore: null,
    };
  }

  if (typeof decoded !== "object" || decoded === null) {
    throw new ResolutionParseError(
      "Settlement event value is not an ScvMap or tuple",
      eventId,
      undefined,
      ResolutionErrorCode.VALUE_NOT_MAP_OR_TUPLE
    );
  }

  const map = decoded as Record<string, unknown>;

  if ("settlement_id" in map) {
    if (isProductionEnv(nodeEnv)) {
      throw new ResolutionParseError(
        "Legacy ScvMap settlement payload is not permitted in production — " +
          "the contract must emit the canonical SettlementEvent shape " +
          "(topics[1]=settlement_id, value={market_id, amount, settled_at})",
        eventId,
        undefined,
        ResolutionErrorCode.LEGACY_SHAPE_REJECTED
      );
    }
    return {
      marketId: String(field(map, "market_id", eventId)),
      outcome: toResolutionOutcome(field(map, "outcome", eventId), eventId),
      oracleAddress: "",
      confidenceScore: null,
    };
  }

  // Canonical on-chain shape: settlement_id via topics[1], market_id and
  // amount in the value map. amount is validated as a money-path value.
  const amount = toSettlementAmount(field(map, "amount", eventId), eventId);
  return {
    marketId: String(field(map, "market_id", eventId)),
    outcome: toResolutionOutcome(field(map, "outcome", eventId), eventId),
    oracleAddress: "",
    confidenceScore: null,
    settlementId: settlementIdFromTopic(topicsXdr, eventId),
    settlementAmount: amount,
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
 *   shape that the canonical contract no longer emits.
 */
export function parseResolutionEvent(
  event: RawChainEvent,
  options: ParseResolutionEventOptions = {}
): NormalizedResolution {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const topicsXdr = event.topicsXdr ?? [];

  if (isSettlementEvent(topicsXdr)) {
    let decoded: unknown;
    try {
      decoded = decodeScVal(event.valueXdr);
    } catch (err) {
      throw new ResolutionParseError(
        "Failed to decode settlement event value XDR",
        event.id,
        err,
        ResolutionErrorCode.BAD_VALUE_XDR
      );
    }
    return parseSettlementPayload(decoded, topicsXdr, event.id, nodeEnv);
  }

  if (!isResolutionEvent(topicsXdr)) {
    throw new ResolutionParseError(
      `Event is not a resolution event (topic: ${String(topicsXdr[0])})`,
      event.id,
      undefined,
      ResolutionErrorCode.WRONG_TOPIC
    );
  }

  let decoded: unknown;
  try {
    decoded = decodeScVal(event.valueXdr);
  } catch (err) {
    throw new ResolutionParseError(
      "Failed to decode event value XDR",
      event.id,
      err,
      ResolutionErrorCode.BAD_VALUE_XDR
    );
  }

  const payload = parseResolutionPayload(decoded, topicsXdr, event.id, nodeEnv);

  return {
    marketId: payload.marketId,
    outcome: payload.outcome,
    oracleAddress: payload.oracleAddress,
    confidenceScore: payload.confidenceScore,
  };
}

/**
 * Parse a batch of RawChainEvents, skipping non-resolution/non-settlement
 * events. Malformed events that match a known topic still throw so the
 * caller can fail the batch closed rather than silently dropping a
 * money-path event.
 */
export function parseResolutionEvents(
  events: RawChainEvent[],
  options: ParseResolutionEventOptions = {}
): NormalizedResolution[] {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const results: NormalizedResolution[] = [];

  for (const event of events) {
    const topicsXdr = event.topicsXdr ?? [];
    if (!isResolutionEvent(topicsXdr) && !isSettlementEvent(topicsXdr)) {
      continue;
    }
    results.push(parseResolutionEvent(event, { ...options, nodeEnv }));
  }

  return results;
}
