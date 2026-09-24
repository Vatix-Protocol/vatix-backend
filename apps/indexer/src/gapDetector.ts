/**
 * Indexer gap detection.
 *
 * Detects missing ledger ranges in an indexed stream so the indexer can
 * backfill before serving liquidity/trading/settlement reads.
 *
 * Invariants:
 *  - Detection is fail-closed: if the source of truth (RPC/DB/Redis) is
 *    unreachable, we MUST NOT report "no gap". We surface a typed error
 *    instead so callers can halt writes.
 *  - Detection is idempotent: replaying the same request (same
 *    correlationId + same observed ranges) yields the same result and does
 *    not double-count or mutate shared state.
 *  - Ranges are half-open [from, to) over ledger sequence numbers.
 */

export const GAP_DETECTION_ERROR_CODES = {
  INVALID_INPUT: 'GAP_DETECTION_INVALID_INPUT',
  SOURCE_UNAVAILABLE: 'GAP_DETECTION_SOURCE_UNAVAILABLE',
  UNAUTHORIZED: 'GAP_DETECTION_UNAUTHORIZED',
} as const;

export type GapDetectionErrorCode =
  (typeof GAP_DETECTION_ERROR_CODES)[keyof typeof GAP_DETECTION_ERROR_CODES];

export class GapDetectionError extends Error {
  readonly code: GapDetectionErrorCode;
  readonly correlationId: string;

  constructor(code: GapDetectionErrorCode, message: string, correlationId: string) {
    super(message);
    this.name = 'GapDetectionError';
    this.code = code;
    this.correlationId = correlationId;
  }
}

/** Half-open ledger range [from, to). */
export interface LedgerRange {
  from: number;
  to: number;
}

export interface GapDetectionRequest {
  /** Observed contiguous ranges, in any order. */
  ranges: LedgerRange[];
  /** Inclusive lower bound of the window under inspection. */
  windowFrom: number;
  /** Exclusive upper bound of the window under inspection. */
  windowTo: number;
  /** Caller-supplied id used for idempotency + log correlation. */
  correlationId: string;
  /** Role of the caller; only trusted roles may run detection. */
  role?: string;
}

export interface GapDetectionResult {
  /** Missing half-open ranges, sorted ascending, non-overlapping. */
  gaps: LedgerRange[];
  /** True when the window is fully covered. */
  complete: boolean;
  correlationId: string;
}

/** Roles permitted to invoke detection. Deny-by-default. */
const ALLOWED_ROLES = new Set(['indexer', 'admin', 'service']);

/**
 * Source of truth for the indexed stream. Implementations must throw when
 * the backing dependency (RPC/DB/Redis) is unreachable so detection can
 * fail closed.
 */
export interface LedgerSource {
  /** Returns observed ranges, or throws if the source is unavailable. */
  fetchObservedRanges(window: LedgerRange): Promise<LedgerRange[]>;
}

function assertValidRange(range: LedgerRange, correlationId: string): void {
  if (
    !Number.isInteger(range.from) ||
    !Number.isInteger(range.to) ||
    range.from < 0 ||
    range.to < range.from
  ) {
    throw new GapDetectionError(
      GAP_DETECTION_ERROR_CODES.INVALID_INPUT,
      `invalid ledger range [${range.from}, ${range.to})`,
      correlationId,
    );
  }
}

/**
 * Normalize ranges: clamp to the window, drop empties, sort, and merge
 * overlaps/adjacent ranges. Pure function — safe under replay/concurrency.
 */
export function normalizeRanges(
  ranges: LedgerRange[],
  window: LedgerRange,
  correlationId: string,
): LedgerRange[] {
  const clamped: LedgerRange[] = [];
  for (const range of ranges) {
    assertValidRange(range, correlationId);
    const from = Math.max(range.from, window.from);
    const to = Math.min(range.to, window.to);
    if (to > from) {
      clamped.push({ from, to });
    }
  }

  clamped.sort((a, b) => a.from - b.from || a.to - b.to);

  const merged: LedgerRange[] = [];
  for (const range of clamped) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

/**
 * Compute gaps within `window` given already-normalized covered ranges.
 * Pure function; deterministic for identical inputs.
 */
export function computeGaps(normalized: LedgerRange[], window: LedgerRange): LedgerRange[] {
  const gaps: LedgerRange[] = [];
  let cursor = window.from;
  for (const range of normalized) {
    if (range.from > cursor) {
      gaps.push({ from: cursor, to: range.from });
    }
    cursor = Math.max(cursor, range.to);
  }
  if (cursor < window.to) {
    gaps.push({ from: cursor, to: window.to });
  }
  return gaps;
}

/**
 * Detect gaps in the indexed stream.
 *
 * Fail-closed: any error from the source of truth is rethrown as a typed
 * SOURCE_UNAVAILABLE error rather than being treated as "no gap".
 */
export async function detectGaps(
  request: GapDetectionRequest,
  source: LedgerSource,
): Promise<GapDetectionResult> {
  const { correlationId } = request;

  if (!correlationId || typeof correlationId !== 'string') {
    throw new GapDetectionError(
      GAP_DETECTION_ERROR_CODES.INVALID_INPUT,
      'correlationId is required',
      correlationId ?? '',
    );
  }

  if (request.role !== undefined && !ALLOWED_ROLES.has(request.role)) {
    throw new GapDetectionError(
      GAP_DETECTION_ERROR_CODES.UNAUTHORIZED,
      `role '${request.role}' is not permitted to run gap detection`,
      correlationId,
    );
  }

  const window: LedgerRange = { from: request.windowFrom, to: request.windowTo };
  assertValidRange(window, correlationId);

  let observed: LedgerRange[];
  try {
    observed = await source.fetchObservedRanges(window);
  } catch (err) {
    throw new GapDetectionError(
      GAP_DETECTION_ERROR_CODES.SOURCE_UNAVAILABLE,
      `ledger source unavailable: ${err instanceof Error ? err.message : String(err)}`,
      correlationId,
    );
  }

  const normalized = normalizeRanges(observed, window, correlationId);
  const gaps = computeGaps(normalized, window);

  return {
    gaps,
    complete: gaps.length === 0,
    correlationId,
  };
}
