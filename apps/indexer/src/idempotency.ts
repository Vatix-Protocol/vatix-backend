import { createHash } from "crypto";
import type {
  RawChainEvent,
  NormalizedTrade,
  NormalizedResolution,
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
 * Parse the Stellar event id into its three numeric components.
 * Format: "{ledger(10d)}-{txIndex(10d)}-{eventIndex(10d)}"
 *
 * @throws Error if the id does not match the expected format
 */
export function parseEventId(
  eventId: string
): Pick<IdempotencyComponents, "ledger" | "txIndex" | "eventIndex"> {
  const parts = eventId.split("-");
  if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(
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
 * @throws Error if the event id cannot be parsed
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

export function withIdempotencyKey(trade: NormalizedTrade): PersistedTrade;
export function withIdempotencyKey(
  resolution: NormalizedResolution
): PersistedResolution;
export function withIdempotencyKey(
  record: NormalizedTrade | NormalizedResolution
): PersistedTrade | PersistedResolution {
  const { key } = generateIdempotencyKey({
    id: record.eventId,
    contractId: record.contractId,
  });
  return { ...record, idempotencyKey: key };
}

// ─── Duplicate insertion guard ───────────────────────────────────────────────

export type InsertResult<T> =
  | { status: "inserted"; record: T }
  | { status: "duplicate"; key: string };

/**
 * Attempt to insert a record using the provided upsert function.
 * The upsert must return `null` (or `undefined`) when the key already exists
 * (i.e. a no-op on conflict), or the inserted record otherwise.
 *
 * This keeps duplicate handling at the storage boundary without leaking
 * database-specific error codes into the parser layer.
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
  upsert: (record: T) => Promise<T | null | undefined>
): Promise<InsertResult<T>> {
  const result = await upsert(record);
  if (result == null) {
    return { status: "duplicate", key: record.idempotencyKey };
  }
  return { status: "inserted", record: result };
}
