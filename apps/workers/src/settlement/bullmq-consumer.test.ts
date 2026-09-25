import { describe, expect, it } from "vitest";
import { resolveSettlementConcurrency } from "./bullmq-consumer.js";

describe("resolveSettlementConcurrency (Issue 2 — double-apply settle_trade)", () => {
  it("fails fast in production when concurrency is misconfigured above 1", () => {
    expect(() =>
      resolveSettlementConcurrency({
        NODE_ENV: "production",
        SETTLEMENT_WORKER_CONCURRENCY: "4",
      })
    ).toThrow(/not supported in production/);
  });

  it("allows concurrency=1 in production (the only safe value)", () => {
    expect(
      resolveSettlementConcurrency({
        NODE_ENV: "production",
        SETTLEMENT_WORKER_CONCURRENCY: "1",
      })
    ).toBe(1);
  });

  it("does not fail-fast outside production even with concurrency > 1 (dev/local stub path)", () => {
    expect(
      resolveSettlementConcurrency({
        NODE_ENV: "development",
        SETTLEMENT_WORKER_CONCURRENCY: "4",
      })
    ).toBe(4);
  });

  it("defaults to concurrency=1 when SETTLEMENT_WORKER_CONCURRENCY is unset", () => {
    expect(resolveSettlementConcurrency({ NODE_ENV: "production" })).toBe(1);
  });

  it("falls back to 1 for a non-numeric or non-positive override", () => {
    expect(
      resolveSettlementConcurrency({
        NODE_ENV: "test",
        SETTLEMENT_WORKER_CONCURRENCY: "not-a-number",
      })
    ).toBe(1);
    expect(
      resolveSettlementConcurrency({
        NODE_ENV: "test",
        SETTLEMENT_WORKER_CONCURRENCY: "-2",
      })
    ).toBe(1);
  });
});
