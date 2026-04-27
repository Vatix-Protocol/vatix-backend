import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

describe("GET /health", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.get("/health", async () => ({
      status: "ok",
      service: "vatix-backend",
    }));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns HTTP 200", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });

  it("returns required payload fields", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(response.body);
    expect(body).toHaveProperty("status", "ok");
    expect(body).toHaveProperty("service", "vatix-backend");
  });

  it("responds quickly (under 200ms)", async () => {
    const start = Date.now();
    await app.inject({ method: "GET", url: "/health" });
    expect(Date.now() - start).toBeLessThan(200);
  });
});
