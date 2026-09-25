import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/index.js";

// Mock prisma so the app boots without a real database — the body-limit
// check happens at the HTTP layer before any route handler (or Prisma call)
// runs, so these requests should never reach it.
vi.mock("../../src/services/prisma.js", () => {
  return {
    getPrismaClient: () => ({
      $queryRaw: async () => {},
    }),
  };
});

describe("Integration: request body size limit (docs/body-limit.md)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer({
      logger: false,
      registerTestRoutes: false,
      readyDeps: {
        checkDatabase: async () => {},
        checkRedis: async () => {},
        getLastIndexedAt: async () => Date.now(),
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects an oversized POST /v1/orders payload with a stable 413", async () => {
    const oversizedPayload = {
      marketId: "some-market-id",
      userAddress: "G" + "A".repeat(55),
      side: "BUY",
      outcome: "YES",
      price: 0.5,
      quantity: 1,
      // Pad well past the default 64 KB limit.
      padding: "x".repeat(100_000),
    };

    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: oversizedPayload,
    });

    expect(response.statusCode).toBe(413);
    const body = JSON.parse(response.body);
    expect(body.statusCode).toBe(413);
    expect(body.error).toBe("Request body is too large");
  });

  it("does not reject a normal-sized payload on body size grounds", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: {
        marketId: "some-market-id",
        userAddress: "G" + "A".repeat(55),
        side: "BUY",
        outcome: "YES",
        price: 0.5,
        quantity: 1,
      },
    });

    // Missing signature headers, so this fails auth/validation — the point
    // is that it's never a 413.
    expect(response.statusCode).not.toBe(413);
  });

  it("413 response body includes statusCode and error fields (docs/body-limit.md contract)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: { padding: "x".repeat(100_000) },
    });

    expect(response.statusCode).toBe(413);
    const body = JSON.parse(response.body);
    // Both fields must be present for client compatibility (docs/body-limit.md)
    expect(typeof body.statusCode).toBe("number");
    expect(body.statusCode).toBe(413);
    expect(typeof body.error).toBe("string");
    expect(body.error).toBe("Request body is too large");
  });
});

describe("Integration: BODY_LIMIT_BYTES env override (docs/body-limit.md)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // Set a very small limit (512 bytes) so we can trigger it without a huge payload.
    vi.stubEnv("BODY_LIMIT_BYTES", "512");

    app = buildServer({
      logger: false,
      registerTestRoutes: false,
      readyDeps: {
        checkDatabase: async () => {},
        checkRedis: async () => {},
        getLastIndexedAt: async () => Date.now(),
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it("honours BODY_LIMIT_BYTES and rejects a payload over the custom limit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/orders",
      payload: { padding: "x".repeat(600) },
    });

    // The 600-byte payload exceeds the 512-byte custom limit.
    expect(response.statusCode).toBe(413);
  });
});
