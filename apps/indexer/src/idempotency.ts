import { createHash } from "crypto";
import type {
  RawChainEvent,
  NormalizedTrade,
  NormalizedResolution,
  NormalizedCollateralDeposit,
  NormalizedMarketCreated,
} from "./types.js";

/**
 * Idempotency key formula
 * ─────────────────────────────────────────────────────────────────────────────
 * The Stellar RPC event `id` field is already a stable, unique composite:
 *
 *   {ledger(10d)}-{txIndex(10d)}-{eventIndex(10d)}
 *   e.g. "0000000042-0000000001-0000000003"
 *
 * We SHA-256 hash the canonical string:
 *
 *   "{contractId}:{ledger}:{txIndex}:{eventIndex}"
 *
 * to produce a fixed-length, URL-safe hex key that:
 *   - is deterministic for the same event across any number of replays
 *   - includes ledger, tx index, and event index as required
 *   - scopes to contractId so keys are globally unique across contracts
 *
 * The raw components are also returned so callers can index or log them
 * without re-parsing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface IdempotencyComponents {
  contractId: string;
  ledger: number;
  txIndex: number;
  eventIndex: number;
}

export interface IdempotencyKey {
  /** SHA-256 hex digest of "{contractId}:{ledger}:{txIndex}:{eventIndex}" */
  key: string;
  components: IdempotencyComponents;
}

/**
 * Stable error codes for idempotency failures. Callers can branch on these
 * without string-matching messages, and they are safe to surface in logs and
 * metrics without leaking secrets.
 */
export const IdempotencyErrorCode = {
  INVALID_EVENT_ID: "IDEMPOTENCY_INVALID_EVENT_ID",
  STORE_UNAVAILABLE: "IDEMPOTENCY_STORE_UNAVAILABLE",
} as const;

export type IdempotencyErrorCode =
  (typeof IdempotencyErrorCode)[keyof typeof IdempotencyErrorCode];

/**
 * Typed error raised by the idempotency layer. Carries a stable `code` and an
 * optional `correlationId` so operators can trace a failure end-to-end.
 */
export class IdempotencyError extends Error {
  readonly code: IdempotencyErrorCode;
  readonly correlationId?: string;

  constructor(
    code: IdempotencyErrorCode,
    message: string,
    options: { correlationId?: string; cause?: unknown } = {}
  ) {
    super(message);
    this.name = "IdempotencyError";
    this.code = code;
    this.correlationId = options.correlationId;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Parse the Stellar event id into its three numeric components.
 * Format: "{ledger(10d)}-{txIndex(10d)}-{eventIndex(10d)}"
 *
 * @throws IdempotencyError with code INVALID_EVENT_ID if the id is malformed
 */
export function parseEventId(
  eventId: string
): Pick<IdempotencyComponents, "ledger" | "txIndex" | "eventIndex"> {
  const parts = typeof eventId === "string" ? eventId.split("-") : [];
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new IdempotencyError(
      IdempotencyErrorCode.INVALID_EVENT_ID,
      `Invalid Stellar event id format: "${eventId}". Expected "{ledger}-{txIndex}-{eventIndex}".`
    );
  }
  return {
    ledger: parseInt(parts[0], 10),
    txIndex: parseInt(parts[1], 10),
    eventIndex: parseInt(parts[2], 10),
  };
}

/**
 * Generate a deterministic idempotency key for a raw chain event.
 *
 * @throws IdempotencyError with code INVALID_EVENT_ID if the event id cannot be parsed
 */
export function generateIdempotencyKey(
  event: Pick<RawChainEvent, "id" | "contractId">
): IdempotencyKey {
  const { ledger, txIndex, eventIndex } = parseEventId(event.id);
  const components: IdempotencyComponents = {
    contractId: event.contractId,
    ledger,
    txIndex,
    eventIndex,
  };
  const canonical = `${event.contractId}:${ledger}:${txIndex}:${eventIndex}`;
  const key = createHash("sha256").update(canonical).digest("hex");
  return { key, components };
}

// ─── Persisted record wrappers ───────────────────────────────────────────────

/** A NormalizedTrade stamped with its idempotency key, ready for storage. */
export interface PersistedTrade extends NormalizedTrade {
  idempotencyKey: string;
}

/** A NormalizedResolution stamped with its idempotency key, ready for storage. */
export interface PersistedResolution extends NormalizedResolution {
  idempotencyKey: string;
}

/** A NormalizedCollateralDeposit stamped with its idempotency key, ready for storage. */
export interface PersistedCollateralDeposit extends NormalizedCollateralDeposit {
  idempotencyKey: string;
}

/** A NormalizedMarketCreated stamped with its idempotency key, ready for storage. */
export interface PersistedMarketCreated extends NormalizedMarketCreated {
  idempotencyKey: string;
}

export function withIdempotencyKey(trade: NormalizedTrade): PersistedTrade;
export function withIdempotencyKey(
  resolution: NormalizedResolution
): PersistedResolution;
export function withIdempotencyKey(
  deposit: NormalizedCollateralDeposit
): PersistedCollateralDeposit;
export function withIdempotencyKey(
  market: NormalizedMarketCreated
): PersistedMarketCreated;
export function withIdempotencyKey(
  record:
    | NormalizedTrade
    | NormalizedResolution
    | NormalizedCollateralDeposit
    | NormalizedMarketCreated
):
  | PersistedTrade
  | PersistedResolution
  | PersistedCollateralDeposit
  | PersistedMarketCreated {
  const { key } = generateIdempotencyKey({
    id: record.eventId,
    contractId: record.contractId,
  });
  return { ...record, idempotencyKey: key };
}

// ─── Duplicate insertion guard ───────────────────────────────────────────────

export type InsertResult<T> =
  { status: "inserted"; record: T } | { status: "duplicate"; key: string };

export interface DuplicateEventLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
}

export interface InsertIfNewOptions {
  logger?: DuplicateEventLogger;
  /** Correlation id propagated into logs and errors for end-to-end tracing. */
  correlationId?: string;
}

export interface InsertBatchResult<T> {
  inserted: T[];
  duplicateCount: number;
}

/**
 * Attempt to insert a record using the provided upsert function.
 * The upsert must return `null` (or `undefined`) when the key already exists
 * (i.e. a no-op on conflict), or the inserted record otherwise.
 *
 * This keeps duplicate handling at the storage boundary without leaking
 * database-specific error codes into the parser layer.
 *
 * Fail-closed: if the storage dependency (DB/Redis/RPC) is unavailable, the
 * upsert throws and we re-throw a typed IdempotencyError with code
 * STORE_UNAVAILABLE. We never swallow the failure and never report the record
 * as inserted, so a money-path event is neither silently skipped nor
 * double-applied on retry.
 *
 * @example
 * ```ts
 * const result = await insertIfNew(persisted, (r) =>
 *   db.trade.upsert({
 *     where: { idempotencyKey: r.idempotencyKey },
 *     create: r,
 *     update: {},   // no-op on conflict
 *   })
 * );
 * if (result.status === "duplicate") console.log("already processed", result.key);
 * ```
 */
export async function insertIfNew<T extends { idempotencyKey: string }>(
  record: T,
  upsert: (record: T) => Promise<T | null | undefined>,
  options: InsertIfNewOptions = {}
): Promise<InsertResult<T>> {
  let result: T | null | undefined;
  try {
    result = await upsert(record);
  } catch (cause) {
    options.logger?.warn?.("Idempotency store unavailable; failing closed", {
      idempotencyKey: record.idempotencyKey,
      correlationId: options.correlationId,
      code: IdempotencyErrorCode.STORE_UNAVAILABLE,
    });
    throw new IdempotencyError(
      IdempotencyErrorCode.STORE_UNAVAILABLE,
      "Idempotency store unavailable; refusing to apply event",
      { correlationId: options.correlationId, cause }
    );
  }

  if (result == null) {
    options.logger?.info("Skipping duplicate indexer event", {
      idempotencyKey: record.idempotencyKey,
      correlationId: options.correlationId,
      duplicateCount: 1,
    });
    return { status: "duplicate", key: record.idempotencyKey };
  }
  return { status: "inserted", record: result };
}

export async function insertAllIfNew<T extends { idempotencyKey: string }>(
  records: T[],
  upsert: (record: T) => Promise<T | null | undefined>,
  options: InsertIfNewOptions = {}
): Promise<InsertBatchResult<T>> {
  const inserted: T[] = [];
  let duplicateCount = 0;

  for (const record of records) {
    const result = await insertIfNew(record, upsert, options);
    if (result.status === "duplicate") {
      duplicateCount++;
      continue;
    }

    inserted.push(result.record);
  }

  if (duplicateCount > 0) {
    options.logger?.info("Skipped duplicate indexer events", {
      duplicateCount,
      correlationId: options.correlationId,
    });
  }

  return { inserted, duplicateCount };
}
