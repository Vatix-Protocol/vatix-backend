import { describe, it, expect, beforeEach } from "vitest";
import {
  incrementOrdersShed,
  setCurrentLag,
  setShedState,
  getMetrics,
  resetMetrics,
  LAG_HISTOGRAM_BUCKETS,
} from "./lag-metrics.js";
import { metricsRegistry } from "./metrics.js";

describe("lag-metrics — histogram vs gauge for Grafana alerts (#981)", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("registers the lag signal as a Prometheus histogram, not only a gauge", async () => {
    // Type is declared even before any observation.
    expect(await metricsRegistry.metrics()).toContain(
      "# TYPE vatix_settlement_lag histogram"
    );

    // After observations, the derived series needed for
    // histogram_quantile()/rate() are exposed.
    setCurrentLag(42);
    const exposition = await metricsRegistry.metrics();
    expect(exposition).toContain("vatix_settlement_lag_bucket");
    expect(exposition).toContain("vatix_settlement_lag_sum");
    expect(exposition).toContain("vatix_settlement_lag_count");
  });

  it("also keeps an instantaneous gauge for dashboards", async () => {
    const exposition = await metricsRegistry.metrics();
    expect(exposition).toContain("# TYPE vatix_settlement_lag_current gauge");
  });

  it("exposes orders-shed as a counter and shedding as a 0/1 gauge", async () => {
    const exposition = await metricsRegistry.metrics();
    expect(exposition).toContain("# TYPE vatix_orders_shed_total counter");
    expect(exposition).toContain("# TYPE vatix_admission_shedding gauge");
  });

  it("uses buckets that straddle the default shed threshold (500)", () => {
    expect(LAG_HISTOGRAM_BUCKETS).toContain(500);
    expect(Math.min(...LAG_HISTOGRAM_BUCKETS)).toBeLessThan(500);
    expect(Math.max(...LAG_HISTOGRAM_BUCKETS)).toBeGreaterThan(500);
    // Buckets must be strictly increasing (prom-client requirement).
    const sorted = [...LAG_HISTOGRAM_BUCKETS].sort((a, b) => a - b);
    expect(LAG_HISTOGRAM_BUCKETS).toEqual(sorted);
  });

  it("setCurrentLag records an observation in the histogram and sets the gauge", async () => {
    setCurrentLag(120);
    setCurrentLag(600);

    const exposition = await metricsRegistry.metrics();
    // Two observations recorded.
    expect(exposition).toMatch(/vatix_settlement_lag_count\{[^}]*\} 2/);
    // le="250" bucket has the 120 observation but not the 600 one.
    expect(exposition).toMatch(
      /vatix_settlement_lag_bucket\{le="250"[^}]*\} 1/
    );
    expect(exposition).toMatch(
      /vatix_settlement_lag_bucket\{le="1000"[^}]*\} 2/
    );
    // Instantaneous gauge reflects the most recent value.
    expect(exposition).toMatch(/vatix_settlement_lag_current\{[^}]*\} 600/);
  });

  it("incrementOrdersShed and setShedState update their series", async () => {
    incrementOrdersShed(3);
    setShedState(true);

    const exposition = await metricsRegistry.metrics();
    expect(exposition).toMatch(/vatix_orders_shed_total\{[^}]*\} 3/);
    expect(exposition).toMatch(/vatix_admission_shedding\{[^}]*\} 1/);
  });

  it("keeps the legacy getMetrics() shape working for existing callers", () => {
    incrementOrdersShed(2);
    setCurrentLag(42);
    setShedState(true);

    expect(getMetrics()).toEqual({
      orders_shed_total: 2,
      current_lag_gauge: 42,
      shed_state_gauge: 1,
    });
  });

  it("resetMetrics clears both the mirrors and the Prometheus series", async () => {
    incrementOrdersShed(5);
    setCurrentLag(300);
    setShedState(true);
    expect(await metricsRegistry.metrics()).toContain(
      "vatix_settlement_lag_bucket"
    );

    resetMetrics();

    expect(getMetrics()).toEqual({
      orders_shed_total: 0,
      current_lag_gauge: 0,
      shed_state_gauge: 0,
    });
    const exposition = await metricsRegistry.metrics();
    // Histogram observations are cleared (prom-client emits no derived
    // series until the next observation).
    expect(exposition).not.toContain("vatix_settlement_lag_bucket");
    expect(exposition).toMatch(/vatix_orders_shed_total\{[^}]*\} 0/);
    expect(exposition).toMatch(/vatix_settlement_lag_current\{[^}]*\} 0/);
  });
});
