/**
 * Metrics for admission control and settlement-lag tracking (#981).
 *
 * Exposed on the shared Prometheus registry (`/metrics`). Two metric *types*
 * are published for lag, on purpose:
 *
 *   - `vatix_settlement_lag_current` (gauge)      — the latest instantaneous
 *     lag score. Useful on dashboards, but a poor alerting signal on its own:
 *     it is a single sampled point, so a threshold rule on it either flaps
 *     (brief spikes) or misses sustained elevation between scrapes.
 *   - `vatix_settlement_lag` (histogram)          — the distribution of lag
 *     scores observed over time. Alert rules use
 *     `histogram_quantile(0.9, rate(vatix_settlement_lag_bucket[5m]))` (or
 *     `_count` / `_sum` for a moving average), which is stable under scrape
 *     jitter and lets Grafana alert on "p90 lag over the last 5m", not "lag
 *     at the instant we happened to scrape".
 *
 * Picking the wrong type here is the failure this issue tracks: alerting on a
 * raw gauge makes rules fire constantly or never.
 *
 * See docs/metrics.md for the alert-rule recipes.
 */
import client from "prom-client";
import { metricsRegistry } from "./metrics.js";

/**
 * Bucket boundaries for the lag histogram. The lag score is roughly
 * `settlementQueueDepth + outboxUnpublishedCount` (see lag-detector.ts); the
 * global shed threshold defaults to 500, so buckets straddle that with
 * headroom on both sides.
 */
export const LAG_HISTOGRAM_BUCKETS = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
];

function getOrCreateGauge(cfg: { name: string; help: string }): client.Gauge {
  return (
    (metricsRegistry.getSingleMetric(cfg.name) as client.Gauge | undefined) ??
    new client.Gauge({ ...cfg, registers: [metricsRegistry] })
  );
}

function getOrCreateCounter(cfg: {
  name: string;
  help: string;
}): client.Counter {
  return (
    (metricsRegistry.getSingleMetric(cfg.name) as client.Counter | undefined) ??
    new client.Counter({ ...cfg, registers: [metricsRegistry] })
  );
}

function getOrCreateHistogram(cfg: {
  name: string;
  help: string;
  buckets: number[];
}): client.Histogram {
  return (
    (metricsRegistry.getSingleMetric(cfg.name) as
      client.Histogram | undefined) ??
    new client.Histogram({ ...cfg, registers: [metricsRegistry] })
  );
}

/** Total orders shed by admission control since process start. */
const ordersShedCounter = getOrCreateCounter({
  name: "vatix_orders_shed_total",
  help: "Total number of orders shed by admission control due to settlement lag",
});

/** Latest instantaneous settlement lag score (dashboard signal). */
const currentLagGaugeMetric = getOrCreateGauge({
  name: "vatix_settlement_lag_current",
  help: "Latest instantaneous settlement lag score (prefer the histogram for alerting)",
});

/** Distribution of settlement lag scores over time (alerting signal). */
const lagHistogram = getOrCreateHistogram({
  name: "vatix_settlement_lag",
  help: "Distribution of settlement lag scores observed by admission control",
  buckets: LAG_HISTOGRAM_BUCKETS,
});

/** 1 while admission control is shedding order traffic, else 0. */
const shedStateGaugeMetric = getOrCreateGauge({
  name: "vatix_admission_shedding",
  help: "Whether admission control is currently shedding order traffic (1) or not (0)",
});

// Plain in-process mirrors, kept for getMetrics() callers/tests.
let ordersShedTotal = 0;
let currentLagGauge = 0;
let shedStateGauge = 0;

/**
 * Increment total orders shed.
 */
export function incrementOrdersShed(count: number = 1): void {
  ordersShedTotal += count;
  ordersShedCounter.inc(count);
}

/**
 * Record the current lag score. Sets the instantaneous gauge AND feeds the
 * histogram so alert rules can work on the distribution over time.
 */
export function setCurrentLag(lag: number): void {
  currentLagGauge = lag;
  currentLagGaugeMetric.set(lag);
  lagHistogram.observe(lag);
}

/**
 * Set shed state gauge (0 = not shedding, 1 = shedding)
 */
export function setShedState(shedding: boolean): void {
  shedStateGauge = shedding ? 1 : 0;
  shedStateGaugeMetric.set(shedding ? 1 : 0);
}

/**
 * Get current metrics for export
 */
export function getMetrics() {
  return {
    orders_shed_total: ordersShedTotal,
    current_lag_gauge: currentLagGauge,
    shed_state_gauge: shedStateGauge,
  };
}

/**
 * Reset metrics (for testing)
 */
export function resetMetrics(): void {
  ordersShedTotal = 0;
  currentLagGauge = 0;
  shedStateGauge = 0;
  ordersShedCounter.reset();
  currentLagGaugeMetric.reset();
  lagHistogram.reset();
  shedStateGaugeMetric.reset();
}
