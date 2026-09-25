/**
 * Unit tests for the order-placement load-test harness (issue #987).
 *
 * The nightly CI job needs a capacity number for admission-watermark tuning
 * and must fail the build on a throughput/latency regression. These tests
 * pin the pure summary + SLO-gate logic that decision rests on, so the gate
 * can't silently rot.
 */
import { describe, it, expect } from "vitest";
import {
  assertLocalTarget,
  evaluateSlo,
  percentile,
  roundToTick,
  summarize,
  type OrderRequestResult,
} from "../scripts/load-test-orders.lib.js";

const result = (status: number, latencyMs: number): OrderRequestResult => ({
  status,
  latencyMs,
});

describe("percentile", () => {
  it("returns 0 for an empty sample", () => {
    expect(percentile([], 95)).toBe(0);
  });

  it("picks the nearest-rank value", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(100);
    expect(percentile(sorted, 100)).toBe(100);
  });
});

describe("roundToTick", () => {
  it("snaps to the 0.01 grid", () => {
    expect(roundToTick(0.514)).toBeCloseTo(0.51, 10);
    expect(roundToTick(0.516)).toBeCloseTo(0.52, 10);
  });
});

describe("assertLocalTarget", () => {
  it("allows localhost / loopback / the compose service name", () => {
    expect(() =>
      assertLocalTarget("http://localhost:3000", false)
    ).not.toThrow();
    expect(() =>
      assertLocalTarget("http://127.0.0.1:3000", false)
    ).not.toThrow();
    expect(() => assertLocalTarget("http://api:3000", false)).not.toThrow();
  });

  it("refuses a non-local host without --allow-remote", () => {
    expect(() =>
      assertLocalTarget("https://api.staging.example.com", false)
    ).toThrow(/Refusing to load-test non-local host/);
  });

  it("permits a non-local host once --allow-remote is set", () => {
    expect(() =>
      assertLocalTarget("https://api.staging.example.com", true)
    ).not.toThrow();
  });
});

describe("summarize", () => {
  it("derives the capacity number from accepted (201) orders per second", () => {
    const results: OrderRequestResult[] = [
      ...Array.from({ length: 270 }, () => result(201, 40)),
      ...Array.from({ length: 30 }, () => result(429, 5)),
    ];

    const summary = summarize(results, 30);

    expect(summary.sent).toBe(300);
    expect(summary.succeeded).toBe(270);
    expect(summary.rateLimited).toBe(30);
    expect(summary.capacityRps).toBe(9); // 270 / 30s
    expect(summary.achievedRps).toBe(10); // 300 / 30s
    // 429s are excluded from the success-rate denominator.
    expect(summary.successRate).toBe(1);
  });

  it("counts transport errors (status 0) separately and out of the latency sample", () => {
    const results: OrderRequestResult[] = [
      result(201, 10),
      result(201, 30),
      result(500, 20),
      result(0, 999),
    ];

    const summary = summarize(results, 1);

    expect(summary.errors).toBe(1);
    expect(summary.succeeded).toBe(2);
    expect(summary.successRate).toBe(0.5); // 2 / (4 - 0 rate-limited)
    expect(summary.latencyMsP99).toBe(30); // 999ms error not in the sample
  });
});

describe("evaluateSlo", () => {
  const baseSummary = summarize(
    Array.from({ length: 100 }, () => result(201, 100)),
    10
  );

  it("is a no-op when no thresholds are configured", () => {
    const slo = evaluateSlo(baseSummary, {});
    expect(slo.evaluated).toBe(false);
    expect(slo.passed).toBe(true);
    expect(slo.violations).toEqual([]);
  });

  it("passes when observed metrics are within the gates", () => {
    const slo = evaluateSlo(baseSummary, {
      maxP95Ms: 200,
      minSuccessRate: 0.95,
    });
    expect(slo.evaluated).toBe(true);
    expect(slo.passed).toBe(true);
  });

  it("fails and explains when p95 latency regresses", () => {
    const slow = summarize(
      Array.from({ length: 100 }, () => result(201, 2000)),
      10
    );
    const slo = evaluateSlo(slow, { maxP95Ms: 1500 });
    expect(slo.passed).toBe(false);
    expect(slo.violations[0]).toMatch(/p95 latency 2000ms exceeds max 1500ms/);
  });

  it("fails when the success rate drops below the floor", () => {
    const degraded = summarize(
      [
        ...Array.from({ length: 80 }, () => result(201, 100)),
        ...Array.from({ length: 20 }, () => result(503, 100)),
      ],
      10
    );
    const slo = evaluateSlo(degraded, { minSuccessRate: 0.95 });
    expect(slo.passed).toBe(false);
    expect(slo.violations[0]).toMatch(/success rate 0\.8 below min 0\.95/);
  });
});
