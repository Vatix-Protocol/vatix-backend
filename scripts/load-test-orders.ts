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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TICK_SIZE = 0.01;
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "api", // docker-compose service name, reachable from other compose services
]);

interface CliOptions {
  baseUrl: string;
  rps: number;
  durationSeconds: number;
  marketId?: string;
  traderCount: number;
  allowRemote: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    baseUrl: process.env.LOAD_TEST_BASE_URL ?? "http://localhost:3000",
    rps: 100,
    durationSeconds: 30,
    traderCount: 20,
    allowRemote: false,
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
  -h, --help            Show this help
`);
}

function log(
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

function assertLocalTarget(baseUrl: string, allowRemote: boolean): void {
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

function roundToTick(price: number): number {
  return Math.round(price / TICK_SIZE) * TICK_SIZE;
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

interface OrderRequestResult {
  status: number;
  latencyMs: number;
  error?: string;
}

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
  const message = buildSignableMessage({ ...body, timestamp });
  const signature = trader.keypair.sign(message).toString("base64");

  const start = performance.now();
  try {
    const res = await fetch(`${baseUrl}/v1/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature": signature,
        "x-timestamp": String(timestamp),
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

function percentile(sortedLatencies: number[], p: number): number {
  if (sortedLatencies.length === 0) return 0;
  const index = Math.min(
    sortedLatencies.length - 1,
    Math.ceil((p / 100) * sortedLatencies.length) - 1
  );
  return sortedLatencies[Math.max(0, index)];
}

function report(results: OrderRequestResult[], options: CliOptions): void {
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
  const achievedRps = results.length / options.durationSeconds;

  log("info", "Load test complete", {
    sent: results.length,
    achievedRps: Number(achievedRps.toFixed(1)),
    statusCounts: Object.fromEntries(byStatus),
    succeeded,
    rateLimited,
    latencyMsP50: Number(percentile(latencies, 50).toFixed(1)),
    latencyMsP95: Number(percentile(latencies, 95).toFixed(1)),
    latencyMsP99: Number(percentile(latencies, 99).toFixed(1)),
  });

  if (rateLimited > 0) {
    log(
      "warn",
      "Requests were rate-limited (429). If you want to sustain the target " +
        "rps against the write endpoint, raise RATE_LIMIT_WRITE_MAX / " +
        "RATE_LIMIT_WRITE_WINDOW_MS on the target API for this local run only.",
      { rateLimited }
    );
  }
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
  report(results, options);
}

void main().catch((error) => {
  log("error", "Load test failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
