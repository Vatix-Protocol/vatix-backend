import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";
import { healthRoutes } from "../../src/api/routes/health.js";

describe("GET /v1/health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(healthRoutes, { prefix: "/v1" });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns HTTP 200", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200);
  });

  it("returns required payload fields", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("service", "vatix-backend");
    expect(body).toHaveProperty("dependencies");
  });

  it("responds quickly (under 200ms)", async () => {
    const start = Date.now();
    await app.inject({ method: "GET", url: "/v1/health" });
    expect(Date.now() - start).toBeLessThan(200);
  });
});
