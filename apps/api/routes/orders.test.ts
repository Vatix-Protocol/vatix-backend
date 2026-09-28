import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ordersRoutes,
  resetOrderRateLimits,
  sweepExpiredRateLimitEntries,
} from "./orders.js";
import { getPrismaClient } from "../../../src/services/prisma.js";
import type { PrismaClient } from "../../../src/generated/prisma/client";

// Well-formed Stellar public keys (56 chars, base32 alphabet) so the
// address-drift guard in `authenticate()` is exercised for real.
const ALICE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const mockPrisma = {
  $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]),
  order: {
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  market: {
    findUnique: vi.fn(),
  },
} as unknown as PrismaClient;

vi.mock("../../../src/services/prisma.js", () => ({
  getPrismaClient: () => mockPrisma,
}));

/**
 * Principal the fake session/JWT layer attaches to each request. `undefined`
 * models an unauthenticated caller.
 */
let principal: unknown;

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  // Stands in for the session/JWT middleware this module expects upstream.
  app.addHook("onRequest", (request, _reply, done) => {
    (request as { user?: unknown }).user = principal;
    done();
  });
  app.register(ordersRoutes);
  return app;
}

const liveMarket = { id: "market-1", deletedAt: null, status: "ACTIVE" };

const baseBody = {
  marketId: "market-1",
  side: "BUY",
  outcome: "YES",
  price: "0.50",
  quantity: 10,
};

describe("apps/api orders routes", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetOrderRateLimits();
    principal = undefined;
    vi.clearAllMocks();
    vi.mocked(mockPrisma.$queryRaw).mockResolvedValue([{ ok: 1 }] as never);
    vi.mocked(mockPrisma.order.findMany).mockResolvedValue([]);
    vi.mocked(mockPrisma.order.count).mockResolvedValue(0);
    vi.mocked(mockPrisma.order.findUnique).mockResolvedValue(null);
    vi.mocked(mockPrisma.market.findUnique).mockResolvedValue(
      liveMarket as never
    );
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // =========================================================================
  // #1125 - authz on every entrypoint, reads included
  // =========================================================================
  describe("authz (deny-by-default)", () => {
    it.each([
      ["GET", "/orders"],
      ["GET", "/orders/order-1"],
      ["POST", "/orders"],
      ["POST", "/orders/order-1/cancel"],
    ] as const)(
      "rejects %s %s with 401 when no principal is present",
      async (method, url) => {
        const response = await app.inject({
          method,
          url,
          payload:
            method === "POST" && url === "/orders" ? baseBody : undefined,
        });

        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe("ORDERS_UNAUTHORIZED");
      }
    );

    it("rejects a principal whose id is not a Stellar account (address drift)", async () => {
      principal = { id: "not-a-stellar-key", role: "TRADER" };

      const response = await app.inject({ method: "GET", url: "/orders" });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("ORDERS_UNAUTHORIZED");
      expect(mockPrisma.order.findMany).not.toHaveBeenCalled();
    });

    it("rejects a write from a principal with the wrong role", async () => {
      principal = { id: ALICE, role: "VIEWER" };

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: baseBody,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("ORDERS_FORBIDDEN");
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    it("allows a TRADER to write", async () => {
      principal = { id: ALICE, role: "TRADER" };
      vi.mocked(mockPrisma.order.create).mockResolvedValue({
        id: "order-1",
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: baseBody,
      });

      expect(response.statusCode).toBe(201);
    });

    // The read endpoints used to be completely unauthenticated: any caller
    // could page through every trader's order book.
    it("scopes GET /orders to the caller's own orders", async () => {
      principal = { id: ALICE, role: "TRADER" };

      await app.inject({ method: "GET", url: "/orders" });

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userAddress: ALICE } })
      );
      expect(mockPrisma.order.count).toHaveBeenCalledWith({
        where: { userAddress: ALICE },
      });
    });

    it("lets an ADMIN list across traders", async () => {
      principal = { id: BOB, role: "ADMIN" };

      await app.inject({ method: "GET", url: "/orders" });

      expect(mockPrisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} })
      );
    });

    it("hides another trader's order behind a 404 rather than a 403", async () => {
      principal = { id: ALICE, role: "TRADER" };
      vi.mocked(mockPrisma.order.findUnique).mockResolvedValue({
        id: "order-1",
        userAddress: BOB,
        status: "OPEN",
      } as never);

      const response = await app.inject({
        method: "GET",
        url: "/orders/order-1",
      });

      // 403 would confirm the order id exists; 404 leaks nothing.
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("ORDERS_NOT_FOUND");
    });

    it("refuses to cancel another trader's order", async () => {
      principal = { id: ALICE, role: "TRADER" };
      vi.mocked(mockPrisma.order.findUnique).mockResolvedValue({
        id: "order-1",
        userAddress: BOB,
        status: "OPEN",
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders/order-1/cancel",
      });

      expect(response.statusCode).toBe(403);
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // #1125 - rate limiting on the money path
  // =========================================================================
  describe("rate limiting", () => {
    it("rate-limits mutating routes and returns the stable error envelope", async () => {
      principal = { id: ALICE, role: "TRADER" };

      let last;
      for (let i = 0; i < 31; i++) {
        last = await app.inject({
          method: "POST",
          url: "/orders",
          payload: baseBody,
        });
      }

      expect(last!.statusCode).toBe(429);
      const body = last!.json();
      expect(body.error.code).toBe("ORDERS_RATE_LIMITED");
      expect(typeof body.error.correlationId).toBe("string");
      expect(last!.headers["retry-after"]).toBeDefined();
    });

    it("gives mutating routes a tighter budget than reads", async () => {
      principal = { id: ALICE, role: "TRADER" };

      for (let i = 0; i < 30; i++) {
        await app.inject({ method: "GET", url: "/orders" });
      }
      const reads = await app.inject({ method: "GET", url: "/orders" });
      expect(reads.statusCode).toBe(200);

      // The read budget is 120/min, so 31 mutations is over the write budget
      // but would be nowhere near the read budget.
      let last;
      for (let i = 0; i < 31; i++) {
        last = await app.inject({
          method: "POST",
          url: "/orders",
          payload: baseBody,
        });
      }
      expect(last!.statusCode).toBe(429);
    });

    it("sweeps expired windows so identities do not accumulate forever", () => {
      const now = Date.now();
      // A sweep long after the window must be a safe no-op, not a crash, and
      // must leave the limiter usable for new identities.
      expect(() =>
        sweepExpiredRateLimitEntries(now + 10 * 60_000)
      ).not.toThrow();
      expect(() => sweepExpiredRateLimitEntries(now)).not.toThrow();
    });
  });

  // =========================================================================
  // #1125 - fail-closed on dependency outage
  // =========================================================================
  describe("fail-closed writes", () => {
    it.each([
      ["POST", "/orders"],
      ["POST", "/orders/order-1/cancel"],
    ] as const)(
      "rejects %s %s with 503 when the orders store is down",
      async (method, url) => {
        principal = { id: ALICE, role: "TRADER" };
        vi.mocked(mockPrisma.$queryRaw).mockRejectedValue(new Error("db down"));

        const response = await app.inject({
          method,
          url,
          payload:
            method === "POST" && url === "/orders" ? baseBody : undefined,
        });

        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe(
          "ORDERS_DEPENDENCY_UNAVAILABLE"
        );
        expect(mockPrisma.order.create).not.toHaveBeenCalled();
        expect(mockPrisma.order.update).not.toHaveBeenCalled();
      }
    );

    it("rejects with 503 rather than 500 when the write itself fails", async () => {
      principal = { id: ALICE, role: "TRADER" };
      vi.mocked(mockPrisma.order.create).mockRejectedValue(
        new Error("connection terminated")
      );

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: baseBody,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe("ORDERS_DEPENDENCY_UNAVAILABLE");
    });
  });

  // =========================================================================
  // #1125 - idempotency under replay/concurrency
  // =========================================================================
  describe("idempotency", () => {
    beforeEach(() => {
      principal = { id: ALICE, role: "TRADER" };
    });

    const existingOrder = {
      id: "order-1",
      userAddress: ALICE,
      marketId: "market-1",
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 10,
    };

    it("replays the original order when the same key and payload are retried", async () => {
      vi.mocked(mockPrisma.order.findUnique).mockResolvedValue(
        existingOrder as never
      );

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, idempotencyKey: "key-1" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().order.id).toBe("order-1");
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    it("rejects a replayed key carrying a different payload", async () => {
      vi.mocked(mockPrisma.order.findUnique).mockResolvedValue(
        existingOrder as never
      );

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, quantity: 999, idempotencyKey: "key-1" },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("ORDERS_IDEMPOTENCY_CONFLICT");
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    it("does not leak another trader's order when their key is replayed", async () => {
      vi.mocked(mockPrisma.order.findUnique).mockResolvedValue({
        ...existingOrder,
        userAddress: BOB,
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, idempotencyKey: "key-1" },
      });

      expect(response.statusCode).toBe(409);
      expect(response.body).not.toContain("order-1");
      expect(response.body).not.toContain(BOB);
    });

    // Two concurrent requests with the same key race on the unique index; the
    // loser must resolve exactly like a sequential retry, not 500.
    it("resolves a concurrent duplicate via the unique-constraint conflict path", async () => {
      vi.mocked(mockPrisma.order.create).mockRejectedValue(
        Object.assign(new Error("Unique constraint"), { code: "P2002" })
      );
      vi.mocked(mockPrisma.order.findUnique)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(existingOrder as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, idempotencyKey: "key-1" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().order.id).toBe("order-1");
    });

    it("resolves a concurrent duplicate with a different payload as a conflict", async () => {
      vi.mocked(mockPrisma.order.create).mockRejectedValue(
        Object.assign(new Error("Unique constraint"), { code: "P2002" })
      );
      vi.mocked(mockPrisma.order.findUnique)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(existingOrder as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, quantity: 42, idempotencyKey: "key-1" },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.code).toBe("ORDERS_IDEMPOTENCY_CONFLICT");
    });

    it("stores the key on a fresh create", async () => {
      vi.mocked(mockPrisma.order.create).mockResolvedValue({
        id: "order-1",
      } as never);

      await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, idempotencyKey: "key-1" },
      });

      expect(mockPrisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          idempotencyKey: "key-1",
          userAddress: ALICE,
        }),
      });
    });
  });

  // =========================================================================
  // #1125 - validation / adversarial input
  // =========================================================================
  describe("validation", () => {
    beforeEach(() => {
      principal = { id: ALICE, role: "TRADER" };
    });

    it("rejects a price outside (0, 1)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, price: "1.50" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("ORDERS_VALIDATION_FAILED");
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    it("rejects a non-decimal price", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, price: "1e9" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("rejects an oversized quantity", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, quantity: 2_000_000_000 },
      });

      expect(response.statusCode).toBe(400);
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    // Fastify strips properties not declared in the schema. A client that
    // tries to name its own owner must therefore still end up bound to the
    // authenticated principal - never to the address it supplied.
    it("ignores a client-supplied owner field and binds the order to the principal", async () => {
      vi.mocked(mockPrisma.order.create).mockResolvedValue({
        id: "order-1",
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, userAddress: BOB },
      });

      expect(response.statusCode).toBe(201);
      expect(mockPrisma.order.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userAddress: ALICE }),
      });
    });

    it("rejects an idempotency key longer than the column", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: { ...baseBody, idempotencyKey: "k".repeat(65) },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // =========================================================================
  // #1125 - correlation ids
  // =========================================================================
  describe("correlation ids", () => {
    it("echoes a well-formed x-correlation-id on success and on failure", async () => {
      principal = { id: ALICE, role: "TRADER" };

      const ok = await app.inject({
        method: "GET",
        url: "/orders",
        headers: { "x-correlation-id": "corr-1" },
      });
      expect(ok.json().correlationId).toBe("corr-1");

      vi.mocked(mockPrisma.$queryRaw).mockRejectedValue(new Error("db down"));
      const bad = await app.inject({
        method: "POST",
        url: "/orders",
        payload: baseBody,
        headers: { "x-correlation-id": "corr-2" },
      });
      expect(bad.json().error.correlationId).toBe("corr-2");
    });

    it("never echoes a control-character correlation id into the body", async () => {
      principal = { id: ALICE, role: "TRADER" };

      const response = await app.inject({
        method: "GET",
        url: "/orders",
        headers: { "x-correlation-id": "corr" + String.fromCharCode(10) + "x" },
      });

      expect(response.body).not.toContain(String.fromCharCode(10));
    });
  });

  // =========================================================================
  // #1126 - soft-deleted markets are unusable by every write path
  // =========================================================================
  describe("soft-deleted markets (docs/SOFT_DELETED_MARKETS.md)", () => {
    beforeEach(() => {
      principal = { id: ALICE, role: "TRADER" };
    });

    it("rejects an order against a soft-deleted market", async () => {
      vi.mocked(mockPrisma.market.findUnique).mockResolvedValue({
        id: "market-1",
        deletedAt: new Date("2026-01-01T00:00:00Z"),
        status: "ACTIVE",
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: baseBody,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("ORDERS_MARKET_NOT_FOUND");
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    it("rejects an order against a market that does not exist", async () => {
      vi.mocked(mockPrisma.market.findUnique).mockResolvedValue(null as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: baseBody,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("ORDERS_MARKET_NOT_FOUND");
    });

    // `deletedAt !== null` treats an omitted column as deleted, so a broken
    // projection fails closed instead of letting orders through.
    it("fails closed when the soft-delete column cannot be resolved", async () => {
      vi.mocked(mockPrisma.market.findUnique).mockResolvedValue({
        id: "market-1",
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: baseBody,
      });

      expect(response.statusCode).toBe(404);
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    it("allows an order against a live market", async () => {
      vi.mocked(mockPrisma.order.create).mockResolvedValue({
        id: "order-1",
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders",
        payload: baseBody,
      });

      expect(response.statusCode).toBe(201);
      expect(mockPrisma.market.findUnique).toHaveBeenCalledWith({
        where: { id: "market-1" },
      });
    });
  });

  // =========================================================================
  // Cancellation
  // =========================================================================
  describe("cancellation", () => {
    beforeEach(() => {
      principal = { id: ALICE, role: "TRADER" };
    });

    it("is naturally idempotent: replaying a cancel returns the terminal state", async () => {
      vi.mocked(mockPrisma.order.findUnique).mockResolvedValue({
        id: "order-1",
        userAddress: ALICE,
        status: "CANCELLED",
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders/order-1/cancel",
      });

      expect(response.statusCode).toBe(200);
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    });

    it("refuses to cancel a filled order", async () => {
      vi.mocked(mockPrisma.order.findUnique).mockResolvedValue({
        id: "order-1",
        userAddress: ALICE,
        status: "FILLED",
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders/order-1/cancel",
      });

      expect(response.statusCode).toBe(409);
      expect(mockPrisma.order.update).not.toHaveBeenCalled();
    });

    it("bumps the optimistic-concurrency version on cancel", async () => {
      vi.mocked(mockPrisma.order.findUnique).mockResolvedValue({
        id: "order-1",
        userAddress: ALICE,
        status: "OPEN",
      } as never);
      vi.mocked(mockPrisma.order.update).mockResolvedValue({
        id: "order-1",
        status: "CANCELLED",
      } as never);

      const response = await app.inject({
        method: "POST",
        url: "/orders/order-1/cancel",
      });

      expect(response.statusCode).toBe(200);
      expect(mockPrisma.order.update).toHaveBeenCalledWith({
        where: { id: "order-1" },
        data: { status: "CANCELLED", version: { increment: 1 } },
      });
    });
  });
});
