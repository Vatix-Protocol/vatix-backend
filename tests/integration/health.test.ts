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
import { healthRoutes } from "../../src/api/routes/health.js";
import { buildTestApp, resetRateLimits } from "./helpers/build-test-app.js";

describe("GET /v1/health — real route, real DB", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp({ plugins: [healthRoutes] });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetRateLimits();
    vi.restoreAllMocks();
  });

  it("returns 200 with status: ok against the live test DB", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.service).toBe(process.env.SERVICE_NAME ?? "vatix-backend");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.timestamp).toBe("string");
    expect(body.dependencies).toEqual({ database: "ok" });
  });

  it("returns status: degraded and dependencies.database: error when DB is unreachable", async () => {
    // Patch getPrismaClient to throw on $queryRaw
    const prismaModule = await import("../../src/services/prisma.js");
    vi.spyOn(prismaModule, "getPrismaClient").mockReturnValue({
      $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused")),
    } as any);

    const res = await app.inject({ method: "GET", url: "/v1/health" });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(body.status).toBe("degraded");
    expect(body.dependencies).toEqual({ database: "error" });
  });
});
