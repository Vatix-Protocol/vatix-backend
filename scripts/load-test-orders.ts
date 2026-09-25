#!/usr/bin/env tsx
/**
 * Local Order-Placement Load Test
 *
 * Places synthetic BUY/SELL orders against POST /v1/orders at a target rate
 * (default ~100 rps) for a fixed duration, to exercise the API + matching
 * engine under sustained write load. Every order is signed with a real
 * Ed25519 keypair using the same canonical-message scheme the API enforces
 * (see src/api/middleware/stellarAuth.ts), so requests go through the full
 * auth + validation + matching path — not a mocked shortcut.
 *
 * ⚠️  LOCAL USE ONLY. This places real rows in whatever database the target
 * API is backed by. By default the script refuses to run against anything
 * other than localhost/127.0.0.1/the docker-compose "api" service, so it
 * can't accidentally be pointed at a shared or production environment.
 * Do NOT pass --allow-remote to target a staging/production URL.
 *
 * Prerequisites:
 *   - The target API must be running locally (`pnpm dev` or
 *     `docker compose --profile api up`) and reachable at --url.
 *   - At least one ACTIVE market must exist. Run `pnpm prisma:seed` if
 *     you don't have one, or pass --market-id explicitly.
 *   - The write rate limiter (10 req/60s per IP by default — see
 *     src/api/middleware/rateLimiter.ts) will throttle a single-IP load
 *     test almost immediately. Raise it for the local target only, e.g.:
 *       RATE_LIMIT_WRITE_MAX=2000 RATE_LIMIT_WRITE_WINDOW_MS=1000 pnpm dev
 *
 * Usage:
 *   pnpm tsx scripts/load-test-orders.ts
 *   pnpm tsx scripts/load-test-orders.ts --rps 50 --duration 10
 *   pnpm tsx scripts/load-test-orders.ts --market-id abc123 --url http://localhost:3000
 *
 * @module scripts/load-test-orders
 */

import { Keypair } from "@stellar/stellar-sdk";
import { buildSignableMessage } from "../src/api/middleware/stellarAuth.js";
import {
  TICK_SIZE,
  assertLocalTarget,
  evaluateSlo,
  log,
  roundToTick,
  summarize,
  type LoadTestSummary,
  type OrderRequestResult,
} from "./load-test-orders.lib.js";

export {
  assertLocalTarget,
  evaluateSlo,
  percentile,
  roundToTick,
  summarize,
  type LoadTestSummary,
  type OrderRequestResult,
  type SloResult,
  type SloThresholds,
} from "./load-test-orders.lib.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface CliOptions {
  baseUrl: string;
  rps: number;
  durationSeconds: number;
  marketId?: string;
  traderCount: number;
  allowRemote: boolean;
  /**
   * SLO gate: max acceptable p95 latency (ms). When set, the run exits
   * non-zero if the observed p95 exceeds it. Used by the CI nightly job.
   */
  maxP95Ms?: number;
  /**
   * SLO gate: min acceptable fraction of 201-Created responses (0..1),
   * counting only requests that were not rate-limited (429).
   */
  minSuccessRate?: number;
}

function numericEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return value;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    baseUrl: process.env.LOAD_TEST_BASE_URL ?? "http://localhost:3000",
    rps: 100,
    durationSeconds: 30,
    traderCount: 20,
    allowRemote: false,
    maxP95Ms: numericEnv("LOAD_TEST_MAX_P95_MS"),
    minSuccessRate: numericEnv("LOAD_TEST_MIN_SUCCESS_RATE"),
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--url":
        options.baseUrl = args[++i];
        break;
      case "--rps":
        options.rps = Number(args[++i]);
        break;
      case "--duration":
        options.durationSeconds = Number(args[++i]);
        break;
      case "--market-id":
        options.marketId = args[++i];
        break;
      case "--traders":
        options.traderCount = Number(args[++i]);
        break;
      case "--allow-remote":
        options.allowRemote = true;
        break;
      case "--max-p95-ms":
        options.maxP95Ms = Number(args[++i]);
        break;
      case "--min-success-rate":
        options.minSuccessRate = Number(args[++i]);
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  if (!Number.isFinite(options.rps) || options.rps <= 0) {
    throw new Error("--rps must be a positive number");
  }
  if (
    !Number.isFinite(options.durationSeconds) ||
    options.durationSeconds <= 0
  ) {
    throw new Error("--duration must be a positive number of seconds");
  }
  if (!Number.isFinite(options.traderCount) || options.traderCount < 2) {
    throw new Error(
      "--traders must be at least 2 (need both sides of a trade)"
    );
  }
  if (
    options.maxP95Ms !== undefined &&
    (!Number.isFinite(options.maxP95Ms) || options.maxP95Ms <= 0)
  ) {
    throw new Error("--max-p95-ms must be a positive number");
  }
  if (
    options.minSuccessRate !== undefined &&
    (!Number.isFinite(options.minSuccessRate) ||
      options.minSuccessRate < 0 ||
      options.minSuccessRate > 1)
  ) {
    throw new Error("--min-success-rate must be between 0 and 1");
  }

  return options;
}

function printHelp(): void {
  console.log(`
Local order-placement load test (targets ~N req/s against POST /v1/orders).

Options:
  --url <baseUrl>       Target API base URL (default: http://localhost:3000)
  --rps <number>        Target requests per second (default: 100)
  --duration <seconds>  How long to sustain the load (default: 30)
  --market-id <id>      Market to trade against (default: auto-discover an ACTIVE market)
  --traders <number>    Size of the synthetic trader pool (default: 20)
  --allow-remote        Bypass the localhost-only safety guard (do NOT use against prod/staging)
  --max-p95-ms <n>      SLO gate: exit non-zero if observed p95 latency exceeds n ms
  --min-success-rate <r> SLO gate: exit non-zero if the 201 rate (excluding 429s) is below r (0..1)
  -h, --help            Show this help

Env: LOAD_TEST_BASE_URL, LOAD_TEST_MAX_P95_MS, LOAD_TEST_MIN_SUCCESS_RATE
     (CI nightly job sets the two SLO gates so a capacity regression fails the build).
`);
}

// ---------------------------------------------------------------------------
// Synthetic traders
// ---------------------------------------------------------------------------

interface Trader {
  publicKey: string;
  keypair: Keypair;
}

function createTraders(count: number): Trader[] {
  return Array.from({ length: count }, () => {
    const keypair = Keypair.random();
    return { publicKey: keypair.publicKey(), keypair };
  });
}

// ---------------------------------------------------------------------------
// Market discovery
// ---------------------------------------------------------------------------

async function discoverActiveMarketId(baseUrl: string): Promise<string> {
  const res = await fetch(
    `${baseUrl}/v1/markets?status=ACTIVE&limit=1&sort=createdAt&direction=desc`
  );
  if (!res.ok) {
    throw new Error(
      `Failed to list markets (${res.status}): ${await res.text()}`
    );
  }
  const body = (await res.json()) as {
    data?: { markets?: Array<{ id: string }> };
  };
  const market = body.data?.markets?.[0];
  if (!market) {
    throw new Error(
      "No ACTIVE market found. Run `pnpm prisma:seed` or pass --market-id explicitly."
    );
  }
  return market.id;
}

// ---------------------------------------------------------------------------
// API readiness wait
// ---------------------------------------------------------------------------

async function waitForApi(baseUrl: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v1/health`);
      if (res.ok) return;
    } catch {
      // API not reachable yet — keep polling until the timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/v1/health to respond`);
}

// ---------------------------------------------------------------------------
// Order placement
// ---------------------------------------------------------------------------

async function placeOrder(
  baseUrl: string,
  marketId: string,
  trader: Trader,
  side: "BUY" | "SELL",
  price: number,
  quantity: number
): Promise<OrderRequestResult> {
  const body = {
    marketId,
    userAddress: trader.publicKey,
    side,
    outcome: "YES" as const,
    price,
    quantity,
  };
  const timestamp = Date.now();

  const start = performance.now();
  try {
    // Every order needs a fresh single-use nonce from the challenge endpoint.
    const challengeRes = await fetch(`${baseUrl}/v1/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userAddress: trader.publicKey }),
    });
    if (!challengeRes.ok) {
      await challengeRes.text();
      return {
        status: challengeRes.status,
        latencyMs: performance.now() - start,
      };
    }
    const { nonce } = (await challengeRes.json()) as { nonce: string };

    const message = buildSignableMessage({ ...body, nonce, timestamp });
    const signature = trader.keypair.sign(message).toString("base64");

    const res = await fetch(`${baseUrl}/v1/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": signature,
        "x-timestamp": String(timestamp),
        "x-nonce": nonce,
      },
      body: JSON.stringify(body),
    });
    // Drain the body so the connection can be reused.
    await res.text();
    return { status: res.status, latencyMs: performance.now() - start };
  } catch (error) {
    return {
      status: 0,
      latencyMs: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Load generation — fixed-rate scheduler
// ---------------------------------------------------------------------------

async function runLoadTest(
  options: CliOptions,
  marketId: string,
  traders: Trader[]
): Promise<OrderRequestResult[]> {
  const totalRequests = Math.round(options.rps * options.durationSeconds);
  const intervalMs = 1000 / options.rps;
  const results: OrderRequestResult[] = [];
  const inFlight: Promise<void>[] = [];

  log("info", "Load test starting", {
    baseUrl: options.baseUrl,
    marketId,
    rps: options.rps,
    durationSeconds: options.durationSeconds,
    totalRequests,
    traders: traders.length,
  });

  for (let i = 0; i < totalRequests; i++) {
    const trader = traders[i % traders.length];
    const side: "BUY" | "SELL" = i % 2 === 0 ? "BUY" : "SELL";
    const jitter = ((i % 5) - 2) * TICK_SIZE; // +/- up to 2 ticks
    const price = roundToTick(Math.min(0.98, Math.max(0.02, 0.5 + jitter)));
    const quantity = 1 + (i % 10);

    const promise = placeOrder(
      options.baseUrl,
      marketId,
      trader,
      side,
      price,
      quantity
    ).then((result) => {
      results.push(result);
    });
    inFlight.push(promise);

    if (i < totalRequests - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  await Promise.allSettled(inFlight);
  return results;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(
  results: OrderRequestResult[],
  options: CliOptions
): LoadTestSummary {
  const summary = summarize(results, options.durationSeconds);

  log("info", "Load test complete", { ...summary });

  if (summary.rateLimited > 0) {
    log(
      "warn",
      "Requests were rate-limited (429). If you want to sustain the target " +
        "rps against the write endpoint, raise RATE_LIMIT_WRITE_MAX / " +
        "RATE_LIMIT_WRITE_WINDOW_MS on the target API for this local run only.",
      { rateLimited: summary.rateLimited }
    );
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs();

  log(
    "warn",
    "⚠️  This script places real orders. LOCAL USE ONLY — never target a shared staging or production environment."
  );

  assertLocalTarget(options.baseUrl, options.allowRemote);

  await waitForApi(options.baseUrl);

  const marketId =
    options.marketId ?? (await discoverActiveMarketId(options.baseUrl));
  const traders = createTraders(options.traderCount);

  const results = await runLoadTest(options, marketId, traders);
  const summary = report(results, options);

  const slo = evaluateSlo(summary, {
    maxP95Ms: options.maxP95Ms,
    minSuccessRate: options.minSuccessRate,
  });

  if (!slo.evaluated) return;

  if (slo.passed) {
    log("info", "SLO gates passed", {
      capacityRps: summary.capacityRps,
      latencyMsP95: summary.latencyMsP95,
      successRate: summary.successRate,
    });
    return;
  }

  log("error", "SLO gates failed — load/capacity regression", {
    violations: slo.violations,
    capacityRps: summary.capacityRps,
  });
  process.exit(1);
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  void main().catch((error) => {
    log("error", "Load test failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
