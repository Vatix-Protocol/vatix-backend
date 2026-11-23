import { xdr, scValToNative } from "@stellar/stellar-sdk";
import type {
  RawChainEvent,
  NormalizedResolution,
  ResolutionOutcome,
} from "./types.js";
import { ResolutionParseError } from "./types.js";
import type { Telemetry } from "./telemetry.js";

/**
 * Topic index 0 carries the event name symbol. Soroban's #[contractevent]
 * macro snake_cases the event struct name including its literal "Event"
 * suffix, so `MarketResolvedEvent` publishes as "market_resolved_event"
 * (see contracts/market/src/events.rs).
 */
const RESOLUTION_EVENT_TOPIC = "market_resolved_event";

/**
 * Stable error codes for resolution parsing. These are part of the parser's
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
} as const;

export type ResolutionErrorCode =
  (typeof ResolutionErrorCode)[keyof typeof ResolutionErrorCode];

function isProductionEnv(nodeEnv: string): boolean {
  return nodeEnv === "production";
}

function decodeScVal(xdrBase64: string): unknown {
  return scValToNative(xdr.ScVal.fromXDR(xdrBase64, "base64"));
}

function isResolutionEvent(topicsXdr: string[]): boolean {
  if (topicsXdr.length === 0) return false;
  try {
    return decodeScVal(topicsXdr[0]) === RESOLUTION_EVENT_TOPIC;
  } catch {
    return false;
  }
}

function toOutcome(value: unknown, eventId: string): ResolutionOutcome {
  if (typeof value === "boolean") return value ? "YES" : "NO";
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (normalized === "YES" || normalized === "NO") return normalized;
  }
  throw new ResolutionParseError(
    `Field "outcome" has an unrecognized value: ${String(value)}`,
    eventId,
    undefined,
    ResolutionErrorCode.INVALID_OUTCOME
  );
}

function toConfidence(value: unknown, eventId: string): number | null {
  if (value === undefined || value === null) return null;
  const numeric =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "number"
        ? value
        : typeof value === "string" && value.trim() !== ""
          ? Number(value)
          : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw new ResolutionParseError(
      `Field "confidence" is not a valid score: ${String(value)}`,
      eventId,
      undefined,
      ResolutionErrorCode.BAD_CONFIDENCE
    );
  }
  return numeric;
}

function requireField(
  map: Record<string, unknown>,
  key: string,
  eventId: string
): unknown {
  if (!(key in map) || map[key] === undefined) {
    throw new ResolutionParseError(
      `Required field "${key}" is missing from the resolution payload`,
      eventId,
      undefined,
      ResolutionErrorCode.MISSING_FIELD
    );
  }
  return map[key];
}

function rejectLegacyShape(
  event: RawChainEvent,
  shape: string,
  telemetry?: Telemetry
): never {
  telemetry?.record("indexer.parser.legacy_shape_rejected", 1, {
    parser: "resolution",
    eventId: event.id,
    contractId: event.contractId,
    ledger: String(event.ledger),
  });
  throw new ResolutionParseError(
    `Legacy ${shape} resolution payload is not accepted in production — ` +
      "only the canonical on-chain shape (topics[1]=market_id, " +
      "value={outcome, resolved_at}) is valid",
    event.id,
    undefined,
    ResolutionErrorCode.LEGACY_SHAPE_REJECTED
  );
}

/**
 * Parse a single RawChainEvent into a NormalizedResolution.
 *
 * Canonical on-chain shape (MarketResolvedEvent):
 *   topics: [market_resolved_event, market_id: u32]
 *   value:  ScvMap { outcome: bool, resolved_at: u64, confidence?: u32 }
 *
 * Legacy shapes (local devnet/test fixtures only, rejected in production):
 *   - ScvVec 3-tuple [market_id: u32, outcome: bool, resolved_at: u64]
 *   - ScvMap { market_id: symbol, outcome: "YES"|"NO", oracle: symbol }
 *
 * @throws ResolutionParseError on wrong topic, malformed payload, or a
 *   legacy shape in production.
 */
export interface ParseResolutionEventOptions {
  telemetry?: Telemetry;
  /** Defaults to `process.env.NODE_ENV`; override in tests only. */
  nodeEnv?: string;
}

export function parseResolutionEvent(
  event: RawChainEvent,
  options?: ParseResolutionEventOptions
): NormalizedResolution {
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const telemetry = options?.telemetry;

  if (!isResolutionEvent(event.topicsXdr)) {
    throw new ResolutionParseError(
      `Event topic is not "${RESOLUTION_EVENT_TOPIC}"`,
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

  const base = {
    eventId: event.id,
    ledger: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    contractId: event.contractId,
  };

  // ── Canonical on-chain shape: market_id in topics[1], map value ──────────
  if (event.topicsXdr.length >= 2) {
    let marketId: unknown;
    try {
      marketId = decodeScVal(event.topicsXdr[1]);
    } catch (err) {
      throw new ResolutionParseError(
        "Failed to decode market_id topic XDR",
        event.id,
        err,
        ResolutionErrorCode.BAD_MARKET_ID_XDR
      );
    }

    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
      throw new ResolutionParseError(
        "Event value is not an ScvMap",
        event.id,
        undefined,
        ResolutionErrorCode.VALUE_NOT_MAP_OR_TUPLE
      );
    }

    const map = decoded as Record<string, unknown>;
    return {
      ...base,
      marketId: String(marketId),
      outcome: toOutcome(requireField(map, "outcome", event.id), event.id),
      oracleAddress: "",
      confidenceScore: toConfidence(map.confidence, event.id),
    };
  }

  // ── Legacy shapes (devnet/test fixtures only) ────────────────────────────
  if (Array.isArray(decoded)) {
    if (isProductionEnv(nodeEnv)) {
      rejectLegacyShape(event, "ScvVec tuple", telemetry);
    }
    if (decoded.length < 3) {
      throw new ResolutionParseError(
        `Legacy tuple payload must have 3 elements, got ${decoded.length}`,
        event.id,
        undefined,
        ResolutionErrorCode.VALUE_NOT_MAP_OR_TUPLE
      );
    }
    return {
      ...base,
      marketId: String(decoded[0]),
      outcome: toOutcome(decoded[1], event.id),
      oracleAddress: "",
      confidenceScore: null,
    };
  }

  if (typeof decoded === "object" && decoded !== null) {
    if (isProductionEnv(nodeEnv)) {
      rejectLegacyShape(event, "ScvMap", telemetry);
    }
    const map = decoded as Record<string, unknown>;
    const oracle = String(requireField(map, "oracle", event.id) ?? "").trim();
    if (oracle === "") {
      throw new ResolutionParseError(
        'Field "oracle" must not be empty',
        event.id,
        undefined,
        ResolutionErrorCode.MISSING_ORACLE
      );
    }
    return {
      ...base,
      marketId: String(requireField(map, "market_id", event.id)),
      outcome: toOutcome(requireField(map, "outcome", event.id), event.id),
      oracleAddress: oracle,
      confidenceScore: toConfidence(map.confidence, event.id),
    };
  }

  throw new ResolutionParseError(
    "Event value is neither an ScvMap nor a tuple",
    event.id,
    undefined,
    ResolutionErrorCode.VALUE_NOT_MAP_OR_TUPLE
  );
}

/**
 * Parse a batch of raw events, skipping non-resolution events silently.
 * Returns successfully parsed resolutions and collects errors separately
 * so one bad event never drops the whole batch.
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
          : new ResolutionParseError(
              String(err),
              event.id,
              err,
              ResolutionErrorCode.BAD_VALUE_XDR
            )
      );
    }
  }

  return { resolutions, errors };
}
