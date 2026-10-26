import { describe, it, expect } from "vitest";
import * as barrel from "./index.js";

/**
 * Contract test for the indexer package's public surface.
 *
 * `apps/indexer/src/index.ts` is the hand-maintained barrel that defines what
 * downstream consumers (API, workers, ops tooling) may import. This test pins
 * that surface: every documented parser entry point must resolve to a
 * function, every exported error class must be a constructor, and the
 * market-created parser must be reachable through the barrel. If an export is
 * removed or a parser module is left unreferenced, this test fails.
 */
describe("indexer barrel exports", () => {
  const functionExports = [
    "parseTradeEvent",
    "parseTradeEvents",
    "parseResolutionEvent",
    "parseResolutionEvents",
    "parseMarketCreatedChainEvent",
    "parseMarketCreatedEvents",
  ] as const;

  const classExports = [
    "PrismaBatchWriter",
    "PrismaCursorStorageClient",
  ] as const;

  const errorClassExports = [
    "TradeParseError",
    "ResolutionParseError",
    "MarketCreatedParseError",
  ] as const;

  const errorCodeEnumExports = [
    "CollateralDepositedErrorCode",
    "ResolutionErrorCode",
    "MarketCreatedErrorCode",
  ] as const;

  it.each(functionExports)("exports %s as a function", (name) => {
    const value = (barrel as Record<string, unknown>)[name];
    expect(value, `${name} must be exported from the barrel`).toBeDefined();
    expect(typeof value).toBe("function");
  });

  it.each(classExports)("exports %s as a constructor", (name) => {
    const value = (barrel as Record<string, unknown>)[name];
    expect(value, `${name} must be exported from the barrel`).toBeDefined();
    expect(typeof value).toBe("function");
    expect((value as { prototype?: unknown }).prototype).toBeDefined();
  });

  it.each(errorClassExports)("exports %s as an error constructor", (name) => {
    const value = (barrel as Record<string, unknown>)[name];
    expect(value, `${name} must be exported from the barrel`).toBeDefined();
    expect(typeof value).toBe("function");
    expect((value as { prototype?: unknown }).prototype).toBeDefined();
  });

  it.each(errorCodeEnumExports)("exports %s as an error-code enum", (name) => {
    const value = (barrel as Record<string, unknown>)[name];
    expect(value, `${name} must be exported from the barrel`).toBeDefined();
    expect(typeof value).toBe("object");
    expect(value).not.toBeNull();
  });

  it("references the canonical market-created parser module", () => {
    // The barrel must expose the market-created parser so the two
    // overlapping files (src/marketCreatedParser.ts and
    // market-created-parser.ts) are reconciled to a single canonical module.
    expect(typeof barrel.parseMarketCreatedChainEvent).toBe("function");
    expect(typeof barrel.parseMarketCreatedEvents).toBe("function");
  });
});
