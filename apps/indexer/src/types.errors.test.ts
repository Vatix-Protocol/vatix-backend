import { describe, expect, it } from "vitest";

import {
  CollateralDepositedParseError,
  IndexerParseError,
  MarketCreatedParseError,
  ResolutionParseError,
  TradeParseError,
} from "./types.js";

/**
 * These tests pin the observable contract of the IndexerParseError
 * hierarchy. `retry.ts` classifies fatal errors by the stable `name`
 * property, so a refactor that dropped `this.name` would silently
 * reclassify every parse failure as retryable.
 */

describe("IndexerParseError subclasses", () => {
  const cases = [
    { name: "ResolutionParseError", Ctor: ResolutionParseError },
    { name: "TradeParseError", Ctor: TradeParseError },
    { name: "CollateralDepositedParseError", Ctor: CollateralDepositedParseError },
    { name: "MarketCreatedParseError", Ctor: MarketCreatedParseError },
  ] as const;

  for (const { name, Ctor } of cases) {
    describe(name, () => {
      it("sets name to the subclass name", () => {
        const err = new Ctor("event-1", "bad payload");
        expect(err.name).toBe(name);
      });

      it("is an instance of IndexerParseError", () => {
        const err = new Ctor("event-1", "bad payload");
        expect(err).toBeInstanceOf(IndexerParseError);
        expect(err).toBeInstanceOf(Error);
      });

      it("preserves the eventId argument", () => {
        const err = new Ctor("event-42", "bad payload");
        expect(err.eventId).toBe("event-42");
      });

      it("leaves cause undefined when omitted", () => {
        const err = new Ctor("event-1", "bad payload");
        expect(err.cause).toBeUndefined();
      });

      it("attaches cause when provided", () => {
        const cause = new Error("underlying");
        const err = new Ctor("event-1", "bad payload", cause);
        expect(err.cause).toBe(cause);
      });

      it("does not interpolate a secret-looking cause into the message", () => {
        const secret = "SECRET_SENTINEL_9f8e7d6c";
        const err = new Ctor("event-1", "bad payload", new Error(secret));
        expect(err.message).not.toContain(secret);
      });
    });
  }

  describe("TradeParseError", () => {
    it("round-trips errorCode", () => {
      const err = new TradeParseError("event-1", "bad trade", undefined, "TRADE_BAD_AMOUNT");
      expect(err.errorCode).toBe("TRADE_BAD_AMOUNT");
    });

    it("leaves errorCode undefined when omitted", () => {
      const err = new TradeParseError("event-1", "bad trade");
      expect(err.errorCode).toBeUndefined();
    });

    it("preserves errorCode alongside a cause", () => {
      const cause = new Error("underlying");
      const err = new TradeParseError("event-7", "bad trade", cause, "TRADE_BAD_AMOUNT");
      expect(err.name).toBe("TradeParseError");
      expect(err.eventId).toBe("event-7");
      expect(err.cause).toBe(cause);
      expect(err.errorCode).toBe("TRADE_BAD_AMOUNT");
    });
  });
});
