/**
 * Shared indexer types.
 *
 * These types describe the on-chain event shapes the indexer consumes and the
 * normalized records it persists. They are the single source of truth for the
 * MarketCreated parser and must stay in sync with the contract event vectors in
 * `apps/indexer/fixtures/contract-event-vectors.json`.
 */

/**
 * Stable error codes surfaced by the indexer. Callers (and ops dashboards)
 * branch on these codes rather than on free-form messages so that behavior is
 * deterministic and fail-closed.
 */
export enum IndexerErrorCode {
  /** Event payload did not match the expected contract shape. */
  MALFORMED_EVENT = 'MALFORMED_EVENT',
  /** A required field was missing or had the wrong type. */
  INVALID_FIELD = 'INVALID_FIELD',
  /** Numeric field was negative, non-integer, or out of range. */
  INVALID_NUMBER = 'INVALID_NUMBER',
  /** Event was already processed (idempotency guard). */
  DUPLICATE_EVENT = 'DUPLICATE_EVENT',
  /** Event arrived out of order relative to the ledger cursor. */
  OUT_OF_ORDER_EVENT = 'OUT_OF_ORDER_EVENT',
  /** Downstream dependency (RPC/DB/Redis) was unavailable; write aborted. */
  DEPENDENCY_UNAVAILABLE = 'DEPENDENCY_UNAVAILABLE',
}

/**
 * Typed error thrown by the parser and writers. Carries a stable code plus an
 * optional correlation id so logs can be joined without leaking secrets.
 */
export class IndexerError extends Error {
  readonly code: IndexerErrorCode;
  readonly correlationId?: string;

  constructor(code: IndexerErrorCode, message: string, correlationId?: string) {
    super(message);
    this.name = 'IndexerError';
    this.code = code;
    this.correlationId = correlationId;
  }
}

/**
 * Raw MarketCreated event as emitted by the contract and captured in the
 * fixture vectors. Field names and types mirror the contract event shape.
 */
export interface RawMarketCreatedEvent {
  /** Contract event topic, e.g. "MarketCreated". */
  topic: string;
  /** Ledger sequence the event was emitted in. */
  ledgerSeq: number;
  /** Index of the event within the ledger. */
  eventIndex: number;
  /** Contract id that emitted the event. */
  contractId: string;
  /** Market id assigned by the contract. */
  marketId: string;
  /** Address of the market creator. */
  creator: string;
  /** Collateral asset address. */
  collateral: string;
  /** Unix timestamp (seconds) the market was created at. */
  createdAt: number;
}

/**
 * Normalized MarketCreated record persisted by the indexer. Derived from
 * {@link RawMarketCreatedEvent} after validation.
 */
export interface MarketCreatedRecord {
  marketId: string;
  creator: string;
  collateral: string;
  createdAt: number;
  ledgerSeq: number;
  eventIndex: number;
  contractId: string;
  /** Idempotency key: `${ledgerSeq}:${eventIndex}`. */
  idempotencyKey: string;
}

/**
 * Build the canonical idempotency key for an event. Keyed on
 * `ledgerSeq:eventIndex` so concurrent/replayed deliveries collapse to one
 * record.
 */
export function idempotencyKey(ledgerSeq: number, eventIndex: number): string {
  return `${ledgerSeq}:${eventIndex}`;
}
