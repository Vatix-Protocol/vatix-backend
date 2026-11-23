import { describe, it, expect } from "vitest";
import {
  MARKET_STATUSES,
  MARKET_INVALID_TRANSITION_CODE,
  MarketTransitionError,
  assertTransition,
  canTransition,
  isInitialStatus,
  isMarketStatus,
  isResolvable,
  isTerminal,
  isTradable,
  type MarketLifecycleState,
} from "./marketLifecycle.js";
// Re-import through the package barrel (issue #1540): every caller — API
// routes, oracle, indexer, finalization worker — is documented to reach
// `isTradable`/`canTransition` via `@vatix/shared`. Importing from the
// barrel here, instead of re-declaring these two names, is itself the test:
// if a second, local copy of either function ever got exported under the
// same names (from this module or the barrel), the identity check below
// would be the first thing to fail.
import {
  isTradable as barrelIsTradable,
  canTransition as barrelCanTransition,
} from "./index.js";

const LEGAL: Array<[MarketLifecycleState, MarketLifecycleState]> = [
  ["ACTIVE", "RESOLVED"],
  ["ACTIVE", "CANCELLED"],
];

const ALL_EDGES = MARKET_STATUSES.flatMap((from) =>
  MARKET_STATUSES.map(
    (to) => [from, to] as [MarketLifecycleState, MarketLifecycleState]
  )
);

const ILLEGAL = ALL_EDGES.filter(
  ([from, to]) => !LEGAL.some(([lf, lt]) => lf === from && lt === to)
);

describe("market lifecycle transitions", () => {
  it.each(LEGAL)("allows %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each(ILLEGAL)("rejects %s -> %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(MarketTransitionError);
  });

  it("does not allow RESOLVED to transition back to ACTIVE", () => {
    expect(canTransition("RESOLVED", "ACTIVE")).toBe(false);
  });

  it("allows ACTIVE to transition to RESOLVED", () => {
    expect(canTransition("ACTIVE", "RESOLVED")).toBe(true);
  });

  it("does not allow ACTIVE to transition to itself", () => {
    expect(canTransition("ACTIVE", "ACTIVE")).toBe(false);
  });

  it("reports a stable error code and both endpoints", () => {
    try {
      assertTransition("RESOLVED", "ACTIVE");
      expect.unreachable();
    } catch (error) {
      const transitionError = error as MarketTransitionError;
      expect(transitionError.code).toBe(MARKET_INVALID_TRANSITION_CODE);
      expect(transitionError.from).toBe("RESOLVED");
      expect(transitionError.to).toBe("ACTIVE");
    }
  });
});

describe("market lifecycle predicates", () => {
  it.each([
    [
      "ACTIVE",
      { terminal: false, tradable: true, resolvable: true, initial: true },
    ],
    [
      "RESOLVED",
      { terminal: true, tradable: false, resolvable: false, initial: false },
    ],
    [
      "CANCELLED",
      { terminal: true, tradable: false, resolvable: false, initial: false },
    ],
  ] as const)("classifies %s", (status, expected) => {
    expect(isTerminal(status)).toBe(expected.terminal);
    expect(isTradable(status)).toBe(expected.tradable);
    expect(isResolvable(status)).toBe(expected.resolvable);
    expect(isInitialStatus(status)).toBe(expected.initial);
  });

  it("narrows unknown values", () => {
    expect(isMarketStatus("ACTIVE")).toBe(true);
    expect(isMarketStatus("active")).toBe(false);
    expect(isMarketStatus(undefined)).toBe(false);
  });

  it("rejects an unknown market status", () => {
    expect(isMarketStatus("EXPIRED")).toBe(false);
    expect(isMarketStatus("ACTIVE")).toBe(true);
  });
});

describe("the barrel re-exports the lifecycle helpers, not a second copy (#1540)", () => {
  it("re-exports isTradable from the package barrel as the exact same function", () => {
    expect(barrelIsTradable).toBe(isTradable);
  });

  it("re-exports canTransition from the package barrel as the exact same function", () => {
    expect(barrelCanTransition).toBe(canTransition);
  });
});
