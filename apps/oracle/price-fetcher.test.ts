import { describe, it, expect } from "vitest";
import { PriceFetcher, PriceFetcherValidationError } from "./price-fetcher.js";

describe("PriceFetcher", () => {
  const mockLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;

  it("throws 400 on invalid assetId", () => {
    expect(() => new PriceFetcher(mockLogger, { assetId: "", timeoutMs: 1000 })).toThrow(PriceFetcherValidationError);
    expect(() => new PriceFetcher(mockLogger, { assetId: 123 as any, timeoutMs: 1000 })).toThrow(PriceFetcherValidationError);
  });

  it("throws 400 on invalid timeoutMs", () => {
    expect(() => new PriceFetcher(mockLogger, { assetId: "BTC", timeoutMs: -1 })).toThrow(PriceFetcherValidationError);
    expect(() => new PriceFetcher(mockLogger, { assetId: "BTC", timeoutMs: 0 })).toThrow(PriceFetcherValidationError);
    expect(() => new PriceFetcher(mockLogger, { assetId: "BTC", timeoutMs: "1000" as any })).toThrow(PriceFetcherValidationError);
  });

  it("initializes with valid config", () => {
    expect(() => new PriceFetcher(mockLogger, { assetId: "BTC", timeoutMs: 1000 })).not.toThrow();
  });
});
