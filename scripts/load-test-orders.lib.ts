/**
 * Pure helpers for the order-placement load test (issue #987).
 *
 * Kept in a dependency-free module (no API/Prisma/Redis imports) so the
 * summary + SLO-gate logic can be unit-tested without booting the stack.
 * `scripts/load-test-orders.ts` is the CLI that wires these to real HTTP.
 *
 * @module scripts/load-test-orders.lib
 */

export const TICK_SIZE = 0.01;

export const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "api", // docker-compose service name, reachable from other compose services
]);

export function log(
  level: string,
  message: string,
  meta?: Record<string, unknown>
): void {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      component: "load-test-orders",
      message,
      ...meta,
    })
  );
}

export function roundToTick(price: number): number {
  return Math.round(price / TICK_SIZE) * TICK_SIZE;
}

export function percentile(sortedLatencies: number[], p: number): number {
  if (sortedLatencies.length === 0) return 0;
  const index = Math.min(
    sortedLatencies.length - 1,
    Math.ceil((p / 100) * sortedLatencies.length) - 1
  );
  return sortedLatencies[Math.max(0, index)];
}

export interface OrderRequestResult {
  status: number;
  latencyMs: number;
  error?: string;
}

export function assertLocalTarget(baseUrl: string, allowRemote: boolean): void {
  const hostname = new URL(baseUrl).hostname;
  if (LOCAL_HOSTNAMES.has(hostname)) return;

  if (!allowRemote) {
    throw new Error(
      `Refusing to load-test non-local host "${hostname}". This script is ` +
        `for local development only. If you really mean it, pass --allow-remote ` +
        `— but never do this against a shared staging or production environment.`
    );
  }

  log("warn", "⚠️  --allow-remote set: load-testing a non-local host", {
    hostname,
  });
}

export interface LoadTestSummary {
  sent: number;
  succeeded: number;
  rateLimited: number;
  errors: number;
  /** Achieved throughput of accepted (201) orders — the admission-watermark capacity number. */
  capacityRps: number;
  achievedRps: number;
  /** 201 rate over requests that reached the server and were not rate-limited (0..1). */
  successRate: number;
  latencyMsP50: number;
  latencyMsP95: number;
  latencyMsP99: number;
  statusCounts: Record<number, number>;
}

export function summarize(
  results: OrderRequestResult[],
  durationSeconds: number
): LoadTestSummary {
  const byStatus = new Map<number, number>();
  for (const r of results) {
    byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  }

  const latencies = results
    .filter((r) => r.status !== 0)
    .map((r) => r.latencyMs)
    .sort((a, b) => a - b);

  const succeeded = byStatus.get(201) ?? 0;
  const rateLimited = byStatus.get(429) ?? 0;
  const errors = byStatus.get(0) ?? 0;
  const eligible = results.length - rateLimited;

  return {
    sent: results.length,
    succeeded,
    rateLimited,
    errors,
    capacityRps: Number((succeeded / durationSeconds).toFixed(2)),
    achievedRps: Number((results.length / durationSeconds).toFixed(2)),
    successRate: eligible > 0 ? Number((succeeded / eligible).toFixed(4)) : 0,
    latencyMsP50: Number(percentile(latencies, 50).toFixed(1)),
    latencyMsP95: Number(percentile(latencies, 95).toFixed(1)),
    latencyMsP99: Number(percentile(latencies, 99).toFixed(1)),
    statusCounts: Object.fromEntries(byStatus),
  };
}

export interface SloThresholds {
  maxP95Ms?: number;
  minSuccessRate?: number;
}

export interface SloResult {
  /** true when no threshold was configured, or all configured thresholds pass. */
  passed: boolean;
  /** true when at least one threshold was actually evaluated. */
  evaluated: boolean;
  violations: string[];
}

/**
 * Compare an observed load-test summary against optional SLO gates. The CI
 * nightly job sets these so a capacity/latency regression fails the build;
 * a local ad-hoc run leaves them unset and this is a no-op.
 */
export function evaluateSlo(
  summary: LoadTestSummary,
  thresholds: SloThresholds
): SloResult {
  const violations: string[] = [];
  let evaluated = false;

  if (thresholds.maxP95Ms !== undefined) {
    evaluated = true;
    if (summary.latencyMsP95 > thresholds.maxP95Ms) {
      violations.push(
        `p95 latency ${summary.latencyMsP95}ms exceeds max ${thresholds.maxP95Ms}ms`
      );
    }
  }

  if (thresholds.minSuccessRate !== undefined) {
    evaluated = true;
    if (summary.successRate < thresholds.minSuccessRate) {
      violations.push(
        `success rate ${summary.successRate} below min ${thresholds.minSuccessRate}`
      );
    }
  }

  return { passed: violations.length === 0, evaluated, violations };
}
