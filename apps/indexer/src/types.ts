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
