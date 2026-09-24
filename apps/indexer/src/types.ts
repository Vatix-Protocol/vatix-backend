// ─── Trade types ────────────────────────────────────────────────────────────

export type TradeDirection = "buy" | "sell";
export type TradeOutcome = "YES" | "NO";

/**
 * Precision-safe numeric representation.
 * priceRaw and quantityRaw are bigint (base units) to avoid floating-point loss.
 * Callers convert to display values as needed.
 */
export interface NormalizedTrade {
  eventId: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  marketId: string;
  traderAddress: string;
  counterpartyAddress: string;
  direction: TradeDirection;
  outcome: TradeOutcome;
  /** Price in base units (7 decimal places, e.g. 5_000_000n = 0.5) */
  priceRaw: bigint;
  /** Quantity of shares as integer */
  quantityRaw: bigint;
  buyOrderId: string;
  sellOrderId: string;
}

export class TradeParseError extends Error {
  constructor(
    message: string,
    public readonly eventId: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "TradeParseError";
  }
}

// ─── Resolution types ───────────────────────────────────────────────────────

/** The two valid on-chain resolution outcomes, mirroring the Prisma Outcome enum. */
export type ResolutionOutcome = "YES" | "NO";

/**
 * Normalized record produced from a market_resolved chain event.
 * All fields needed for settlement and final PnL are present.
 */
export interface NormalizedResolution {
  eventId: string;
  /** Ledger sequence number — the authoritative source of the resolution. */
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  marketId: string;
  outcome: ResolutionOutcome;
  /** Stellar address of the oracle that submitted the resolution. */
  oracleAddress: string;
}

export class ResolutionParseError extends Error {
  constructor(
    message: string,
    public readonly eventId: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ResolutionParseError";
  }
}

// ─── Collateral deposit types ────────────────────────────────────────────────

/**
 * Contract event: collateral_deposited
 * Payload: Vec [ account: ScvString, market_id: ScvU32, amount: ScvI128 ]
 */
export interface NormalizedCollateralDeposit {
  eventId: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  account: string;
  /** u32 cast to string for DB compatibility */
  marketId: string;
  amountRaw: bigint;
}

export class CollateralDepositedParseError extends Error {
  constructor(
    message: string,
    public readonly eventId: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "CollateralDepositedParseError";
  }
}

// ─── Market created types ────────────────────────────────────────────────────

export type MarketCreatedStatus = "ACTIVE" | "RESOLVED" | "CANCELLED";

/**
 * Normalized record produced from a market_created chain event.
 * The marketId is the on-chain identifier and is expected to match Market.id.
 */
export interface NormalizedMarketCreated {
  eventId: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  /** On-chain market identifier — used as Market.id in Postgres. */
  marketId: string;
  question: string;
  /** ISO-8601 timestamp when the market closes. */
  endTime: string;
  /** Stellar oracle address (56-char base32). */
  oracleAddress: string;
  status: MarketCreatedStatus;
}

export class MarketCreatedParseError extends Error {
  constructor(
    message: string,
    public readonly eventId: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "MarketCreatedParseError";
  }
}

// ─── Soft-delete types ───────────────────────────────────────────────────────

/**
 * Soft-deletion status for a market.
 *
 * Soft-deleted markets must be excluded from every read/listing/aggregation
 * surface (indexer storage queries, market routes, money-path endpoints).
 * Deletion is a first-class status on the market record rather than a hard
 * delete so that historical trades/resolutions remain auditable.
 */
export type MarketDeletionStatus = "ACTIVE" | "SOFT_DELETED";

/**
 * Minimal shape required to decide whether a market may be surfaced.
 * `deletedAt` is the authoritative marker: a non-null value means the market
 * is soft-deleted. `status` is an optional denormalized mirror used by
 * storage layers that persist the status directly.
 */
export interface MarketDeletionState {
  deletedAt?: Date | string | null;
  status?: MarketDeletionStatus | null;
}

/**
 * Fail-closed predicate: returns true only when the market is provably NOT
 * soft-deleted. If deletion status is unknown/unavailable (missing record,
 * unparsable timestamp, unrecognized status), the market is treated as
 * deleted so it is never surfaced on money-path/read endpoints.
 */
export function isMarketVisible(state: MarketDeletionState | null | undefined): boolean {
  if (!state) return false;
  if (state.deletedAt !== undefined && state.deletedAt !== null) return false;
  if (state.status !== undefined && state.status !== null && state.status !== "ACTIVE") {
    return false;
  }
  return true;
}

/**
 * Default filter applied to every market query unless a caller explicitly
 * opts in to including soft-deleted markets (e.g. admin/audit tooling).
 */
export const DEFAULT_MARKET_FILTER = { deletedAt: null } as const;

// ─── Fetcher types ───────────────────────────────────────────────────────────

export interface LedgerWindow {
  startLedger: number;
  endLedger: number;
}

export interface RawChainEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  type: string;
  pagingToken: string;
  // Raw XDR value — parsing is intentionally deferred to a separate layer
  valueXdr: string;
  topicsXdr: string[];
}

export interface FetchEventsResult {
  events: RawChainEvent[];
  latestLedger: number;
}

export interface EventFetcherConfig {
  rpcUrl: string;
  contractId: string;
  maxRetries?: number;
  retryDelayMs?: number;
  pageLimit?: number;
}
