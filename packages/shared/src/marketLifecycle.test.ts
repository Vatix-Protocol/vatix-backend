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
});
