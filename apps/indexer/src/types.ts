// ─── Raw chain event ──────────────────────────────────────────────────────────

export interface RawChainEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  type: string;
  pagingToken: string;
  /** 0-based index of this event within its parent Stellar transaction. */
  eventIndex: number;
  valueXdr: string;
  topicsXdr: string[];
}

// ─── Ledger window ────────────────────────────────────────────────────────────

export interface LedgerWindow {
  startLedger: number;
  endLedger: number;
}

// ─── Event fetcher config ─────────────────────────────────────────────────────

export interface EventFetcherConfig {
  contractId: string;
  rpcUrl?: string | string[];
  maxRetries?: number;
  retryDelayMs?: number;
  pageLimit?: number;
  fetchTimeoutMs?: number;
}

// ─── Fetch result ─────────────────────────────────────────────────────────────

export interface FetchEventsResult {
  events: RawChainEvent[];
  latestLedger: number;
}

// ─── Trade types ──────────────────────────────────────────────────────────────

export type TradeDirection = "buy" | "sell";
export type TradeOutcome = "YES" | "NO";
export type ResolutionOutcome = "YES" | "NO";

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
  priceRaw: bigint;
  quantityRaw: bigint;
  buyOrderId: string;
  sellOrderId: string;
}

export interface NormalizedResolution {
  eventId: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  marketId: string;
  outcome: ResolutionOutcome;
  oracleAddress: string;
  confidenceScore: number | null;
}

export interface NormalizedCollateralDeposit {
  eventId: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  account: string;
  marketId: string;
  amountRaw: bigint;
}

export type MarketStatus = "ACTIVE" | "RESOLVED" | "CANCELLED";

export interface NormalizedMarketCreated {
  eventId: string;
  ledger: number;
  ledgerClosedAt: string;
  contractId: string;
  marketId: string;
  question: string;
  endTime: string;
  oracleAddress: string;
  status: MarketStatus;
}

// ─── Parse error base ─────────────────────────────────────────────────────────

/**
 * Base class for all indexer parse errors.
 * Carries the originating event id and an optional cause for observability.
 * Never includes secret or sensitive data in its message.
 */
export class IndexerParseError extends Error {
  readonly eventId: string;

  constructor(name: string, message: string, eventId: string, cause?: unknown) {
    super(message);
    this.name = name;
    this.eventId = eventId;
    if (cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = cause;
    }
  }
}

/**
 * Trade parse error — stable name used by retry.ts for fatal-error
 * classification and by ingestion.ts for error logging.
 */
export class TradeParseError extends IndexerParseError {
  readonly errorCode?: string;

  constructor(message: string, eventId: string, cause?: unknown, errorCode?: string) {
    super("TradeParseError", message, eventId, cause);
    this.errorCode = errorCode;
  }
}

/**
 * Resolution parse error — stable name used by retry.ts for fatal-error
 * classification and by ingestion.ts for error logging.
 *
 * Carries an optional `errorCode` for callers that want to branch on
 * the specific failure reason without string-matching the message.
 */
export class ResolutionParseError extends IndexerParseError {
  readonly errorCode?: string;

  constructor(message: string, eventId: string, cause?: unknown, errorCode?: string) {
    super("ResolutionParseError", message, eventId, cause);
    this.errorCode = errorCode;
  }
}

/**
 * Collateral deposited parse error — stable name used by retry.ts for
 * fatal-error classification and by ingestion.ts for error logging.
 *
 * Carries an optional `errorCode` for callers that want to branch on
 * the specific failure reason without string-matching the message.
 */
export class CollateralDepositedParseError extends IndexerParseError {
  readonly errorCode?: string;

  constructor(message: string, eventId: string, cause?: unknown, errorCode?: string) {
    super("CollateralDepositedParseError", message, eventId, cause);
    this.errorCode = errorCode;
  }
}

/**
 * Market created parse error — stable name used by retry.ts for fatal-error
 * classification and by ingestion.ts for error logging.
 *
 * Carries an optional `errorCode` for callers that want to branch on
 * the specific failure reason without string-matching the message.
 */
export class MarketCreatedParseError extends IndexerParseError {
  readonly errorCode?: string;

  constructor(message: string, eventId: string, cause?: unknown, errorCode?: string) {
    super("MarketCreatedParseError", message, eventId, cause);
    this.errorCode = errorCode;
  }
}