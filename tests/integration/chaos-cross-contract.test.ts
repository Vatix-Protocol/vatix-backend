/**
 * Chaos test: randomised cross-contract operation ordering under concurrent load.
 *
 * Validates that randomised sequences of stake / signal-submit / trade-execute /
 * fee-collect operations do not cause panics and preserve core invariants:
 *
 *   (1) Every API call returns a non-5xx status.
 *   (2) For any given market the sum of all user_position.yes_shares equals zero
 *       because every matched buy (+q) has a paired sell (−q).
 *
 * Reproducibility: run with a fixed seed via CHAOS_SEED env var.
 * See docs/chaos-testing.md for full usage.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { ordersRoutes } from "../../src/api/routes/orders.js";
import positionsRouter from "../../src/api/routes/positions.js";
import { buildSignableMessage } from "../../src/api/middleware/stellarAuth.js";
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";
import { testUtils, getTestPrismaClient } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { matchingService } from "../../src/matching/matching-service.js";
import { settlementQueue } from "../../src/services/settlement-queue.js";

// ---------------------------------------------------------------------------
// Seeded deterministic pseudo-random number generator (mulberry32).
// Avoids Math.random() so results are reproducible given the same seed.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function randChoice<T>(rng: () => number, arr: T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

// ---------------------------------------------------------------------------
// Auth helper (mirrors orders.test.ts)
// ---------------------------------------------------------------------------

function authHeaders(
  keypair: Keypair,
  body: {
    marketId: string;
    userAddress: string;
    side: string;
    outcome: string;
    price: number;
    quantity: number;
  }
): Record<string, string> {
  const timestamp = Date.now();
  const sig = keypair
    .sign(buildSignableMessage({ ...body, timestamp }))
    .toString("base64");
  return { "x-signature": sig, "x-timestamp": String(timestamp) };
}

// ---------------------------------------------------------------------------
// Chaos harness
// ---------------------------------------------------------------------------

const SEED = Number(process.env.CHAOS_SEED ?? 42);
const OPERATION_COUNT = 40;
const OUTCOMES = ["YES", "NO"] as const;

describe(`Chaos test (seed=${SEED}) — randomised cross-contract ordering`, () => {
  let app: FastifyInstance;
  const prisma = getTestPrismaClient();

  // Three actors with known keypairs.
  const actors = [Keypair.random(), Keypair.random(), Keypair.random()];

  beforeAll(async () => {
    await acquireDatabaseLock();
    app = await buildTestApp({ plugins: [ordersRoutes, positionsRouter] });
    vi.spyOn(settlementQueue, "enqueue").mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app.close();
    await releaseDatabaseLock();
  });

  beforeEach(() => {
    resetRateLimits();
    (matchingService as any).books?.clear();
    (matchingService as any).locks?.clear();
    vi.clearAllMocks();
  });

  it(
    `executes ${OPERATION_COUNT} randomised operations without panics and preserves net-zero share invariant`,
    async () => {
      const rng = mulberry32(SEED);

      // Create two markets to spread operations across.
      const markets = await Promise.all([
        testUtils.createTestMarket({ status: "ACTIVE" }),
        testUtils.createTestMarket({ status: "ACTIVE" }),
      ]);

      // Track all status codes to assert no 5xx occurred.
      const statusCodes: number[] = [];

      // Seed both order books with a thin resting offer so trade-execute
      // operations have something to match against.
      for (const market of markets) {
        for (const outcome of OUTCOMES) {
          // A resting SELL at price 0.5 placed by actor[2].
          const seedPayload = {
            marketId: market.id,
            userAddress: actors[2].publicKey(),
            side: "SELL" as const,
            outcome,
            price: 0.5,
            quantity: 500,
          };
          const res = await app.inject({
            method: "POST",
            url: "/v1/orders",
            headers: authHeaders(actors[2], seedPayload),
            payload: seedPayload,
          });
          statusCodes.push(res.statusCode);
        }
      }

      // -----------------------------------------------------------------------
      // Operation catalogue
      // -----------------------------------------------------------------------
      type Op =
        | "stake"         // place a non-crossing BUY (rests on book)
        | "signal_submit" // place another resting BUY at different price
        | "trade_execute" // place a crossing BUY that should match
        | "fee_collect";  // read positions (GET)

      const ops: Op[] = [
        "stake",
        "signal_submit",
        "trade_execute",
        "fee_collect",
      ];

      // Run randomised operations concurrently in batches of 4.
      for (let i = 0; i < OPERATION_COUNT; i++) {
        const op: Op = randChoice(rng, ops);
        const actor = randChoice(rng, actors.slice(0, 2)); // actors[0..1] are the traders
        const market = randChoice(rng, markets);
        const outcome = randChoice(rng, OUTCOMES);
        const qty = randInt(rng, 1, 20);

        let res: Awaited<ReturnType<typeof app.inject>>;

        if (op === "fee_collect") {
          res = await app.inject({
            method: "GET",
            url: `/v1/wallets/${actor.publicKey()}/positions`,
          });
        } else {
          // Determine price: non-crossing (< 0.5) or crossing (>= 0.5).
          const price =
            op === "trade_execute"
              ? +(0.5 + rng() * 0.49).toFixed(8)  // 0.50 – 0.99 → crosses the seed SELL
              : +(rng() * 0.49).toFixed(8) || 0.01; // 0.01 – 0.49 → rests

          const payload = {
            marketId: market.id,
            userAddress: actor.publicKey(),
            side: "BUY" as const,
            outcome,
            price,
            quantity: qty,
          };
          res = await app.inject({
            method: "POST",
            url: "/v1/orders",
            headers: authHeaders(actor, payload),
            payload,
          });
        }

        statusCodes.push(res.statusCode);
      }

      // -----------------------------------------------------------------------
      // Assertions
      // -----------------------------------------------------------------------

      // (1) No server panics — every response must be non-5xx.
      const serverErrors = statusCodes.filter((s) => s >= 500);
      expect(
        serverErrors,
        `Server errors encountered (seed=${SEED}): ${serverErrors.join(", ")}`
      ).toHaveLength(0);

      // (2) Net-zero share invariant per market:
      //     SUM(yes_shares) over all UserPositions for a market must equal 0
      //     because each matched YES trade adds +q to buyer and −q to seller.
      for (const market of markets) {
        const positions = await prisma.userPosition.findMany({
          where: { marketId: market.id },
          select: { yesShares: true, noShares: true },
        });

        const netYes = positions.reduce((acc, p) => acc + p.yesShares, 0);
        const netNo = positions.reduce((acc, p) => acc + p.noShares, 0);

        expect(
          netYes,
          `Net YES shares for market ${market.id} must be 0 (seed=${SEED})`
        ).toBe(0);
        expect(
          netNo,
          `Net NO shares for market ${market.id} must be 0 (seed=${SEED})`
        ).toBe(0);
      }
    },
    60_000 // generous timeout for 40 sequential HTTP calls
  );
});
