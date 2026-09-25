/**
 * Canonical market lifecycle state machine.
 *
 * This module is the single source of truth for which market status
 * transitions are legal. API routes, the oracle, the indexer and the
 * finalization worker all guard their writes with these helpers instead of
 * encoding ad-hoc status checks, so the matrix cannot drift per service.
 *
 *   ACTIVE ──► RESOLVED   (finalization accepts a resolution candidate)
 *      │
 *      └────► CANCELLED   (admin cancels the market)
 *
 * RESOLVED and CANCELLED are terminal: nothing may leave them.
 */

export const MARKET_STATUSES = ["ACTIVE", "RESOLVED", "CANCELLED"] as const;

export type MarketLifecycleState = (typeof MARKET_STATUSES)[number];

/**
 * Allowed successor states for each lifecycle state.
 * A state mapped to an empty list is terminal.
 */
export const MARKET_TRANSITIONS: Readonly<
  Record<MarketLifecycleState, readonly MarketLifecycleState[]>
> = {
  ACTIVE: ["RESOLVED", "CANCELLED"],
  RESOLVED: [],
  CANCELLED: [],
};

/** States a market may be created in. */
export const INITIAL_MARKET_STATUSES: readonly MarketLifecycleState[] = [
  "ACTIVE",
];

/** States in which orders may be placed or matched. */
export const TRADABLE_MARKET_STATUSES: readonly MarketLifecycleState[] = [
  "ACTIVE",
];

/** States from which a resolution may be proposed or finalized. */
export const RESOLVABLE_MARKET_STATUSES: readonly MarketLifecycleState[] = [
  "ACTIVE",
];

/** Stable error code emitted for every illegal transition. */
export const MARKET_INVALID_TRANSITION_CODE = "market_invalid_transition";

/** Stable error code emitted when a market is not in a tradable state. */
export const MARKET_NOT_TRADABLE_CODE = "market_not_tradable";

export class MarketTransitionError extends Error {
  readonly code = MARKET_INVALID_TRANSITION_CODE;
  readonly from: MarketLifecycleState;
  readonly to: MarketLifecycleState;

  constructor(from: MarketLifecycleState, to: MarketLifecycleState) {
    super(`Illegal market transition ${from} -> ${to}`);
    this.name = "MarketTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function isMarketStatus(value: unknown): value is MarketLifecycleState {
  return (
    typeof value === "string" &&
    (MARKET_STATUSES as readonly string[]).includes(value)
  );
}

/** True when `to` is a legal successor of `from`. Self-transitions are illegal. */
export function canTransition(
  from: MarketLifecycleState,
  to: MarketLifecycleState
): boolean {
  return MARKET_TRANSITIONS[from].includes(to);
}

/**
 * Throws {@link MarketTransitionError} when the transition is illegal.
 * Use at every write path that changes a market's status.
 */
export function assertTransition(
  from: MarketLifecycleState,
  to: MarketLifecycleState
): void {
  if (!canTransition(from, to)) {
    throw new MarketTransitionError(from, to);
  }
}

export function isTerminal(status: MarketLifecycleState): boolean {
  return MARKET_TRANSITIONS[status].length === 0;
}

export function isTradable(status: MarketLifecycleState): boolean {
  return TRADABLE_MARKET_STATUSES.includes(status);
}

export function isResolvable(status: MarketLifecycleState): boolean {
  return RESOLVABLE_MARKET_STATUSES.includes(status);
}

export function isInitialStatus(status: MarketLifecycleState): boolean {
  return INITIAL_MARKET_STATUSES.includes(status);
}
