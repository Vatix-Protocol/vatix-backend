/**
 * Integration test: build-test-app lease enablement (#991).
 *
 * The integration helper `buildTestApp` used to always run with the matching
 * leader lease bypassed (`MATCHING_LEASE_ENFORCED=false`), so the production
 * single-writer path — where `matchingService.placeOrder` refuses to match
 * unless this process holds the Redis-backed lease — was never exercised by
 * an HTTP-level test. `buildTestApp({ enableLease: true })` now acquires the
 * real lease before the app is ready and enforces it for the app's lifetime.
 *
 * Acceptance criteria under test:
 *  - With `enableLease: true`, the app holds the lease and `POST /v1/orders`
 *    goes through the real `leaderLease.isLeader()` gate and succeeds.
 *  - Enablement is explicit and fail-fast: env is forced to `"true"` while
 *    the app is up and restored on `app.close()`; the lease is released too.
 *  - The default (no `enableLease`) path is unchanged.
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
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";
import { placeOrder, seedMarket } from "./helpers/market-order.js";
import { getTestPrismaClient } from "../setup.js";
import {
  acquireDatabaseLock,
  releaseDatabaseLock,
} from "../helpers/test-database.js";
import { leaderLease } from "../../src/matching/leader-lease.js";
import { matchingService } from "../../src/matching/matching-service.js";
import { settlementQueue } from "../../src/services/settlement-queue.js";

describe("buildTestApp — matching leader lease enablement (#991)", () => {
  const prisma = getTestPrismaClient();
  const trader = Keypair.random();

  beforeAll(async () => {
    await acquireDatabaseLock();
    vi.spyOn(settlementQueue, "enqueue").mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await releaseDatabaseLock();
    await leaderLease.release();
  });

  beforeEach(() => {
    resetRateLimits();
    (
      matchingService as unknown as { books?: Map<string, unknown> }
    ).books?.clear();
  });

  it("acquires the lease and enforces it for the app lifetime, then restores env on close", async () => {
    const previous = process.env.MATCHING_LEASE_ENFORCED;

    const app = await buildTestApp({
      plugins: [ordersRoutes],
      enableLease: true,
    });

    try {
      expect(leaderLease.isLeader()).toBe(true);
      expect(process.env.MATCHING_LEASE_ENFORCED).toBe("true");
    } finally {
      await app.close();
    }

    expect(leaderLease.isLeader()).toBe(false);
    expect(process.env.MATCHING_LEASE_ENFORCED).toBe(previous);
  }, 20000);

  it("lets a matched-engine write go through the real isLeader() gate", async () => {
    const app = await buildTestApp({
      plugins: [ordersRoutes],
      enableLease: true,
    });

    try {
      const market = await seedMarket();

      const res = await placeOrder(app, trader, {
        marketId: market.id,
        side: "BUY",
        outcome: "YES",
        price: 0.4,
        quantity: 25,
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.order.status).toBe("OPEN");
      expect(body.trades).toHaveLength(0);

      const persisted = await prisma.order.findUnique({
        where: { id: body.order.id },
      });
      expect(persisted?.status).toBe("OPEN");
    } finally {
      await app.close();
    }
  }, 20000);

  it("does not touch MATCHING_LEASE_ENFORCED when enableLease is omitted", async () => {
    const previous = process.env.MATCHING_LEASE_ENFORCED;

    const app = await buildTestApp({ plugins: [ordersRoutes] });
    try {
      expect(process.env.MATCHING_LEASE_ENFORCED).toBe(previous);
    } finally {
      await app.close();
    }
  });
});
