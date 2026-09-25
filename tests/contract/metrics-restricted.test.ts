/**
 * Contract tests for the restricted Prometheus scrape endpoint (#1130).
 *
 * Exercises the real route (not just the decision helper) with a scrape bearer
 * token configured, so the 401/403 responses and the exposition format are
 * verified end-to-end. The token must be set before src/config.ts is loaded,
 * hence the dynamic import of the route.
 *
 * The route is registered on a bare Fastify instance instead of buildServer():
 * this test is about /metrics authz, and it deliberately avoids pulling in the
 * whole API (DB, matching engine, queues).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/vatix";
process.env.METRICS_SCRAPE_TOKEN = "test-scrape-token";

const { metricsRoutes } = await import("../../src/api/routes/metrics.js");

describe("GET /metrics with scrape authz (#1130)", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = Fastify({ logger: false });
    await server.register(metricsRoutes);
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("rejects an unauthenticated scrape with 401 and a stable code", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({
      code: "METRICS_AUTH_MISSING",
      statusCode: 401,
    });
    expect(res.headers["www-authenticate"]).toContain("Bearer");
    // The metric body must never leak on a denial.
    expect(res.body).not.toContain("vatix_process_");
  });

  it("rejects a wrong bearer token with 401", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "METRICS_AUTH_INVALID" });
    expect(res.body).not.toContain("wrong-token");
  });

  it("serves the exposition format for the configured token", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/metrics",
      headers: { authorization: "Bearer test-scrape-token" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toContain("vatix_process_cpu_user_seconds_total");
  });

  it("counts rejected scrapes so a metrics gap is alertable", async () => {
    const { metricsScrapeRejectedTotal } =
      await import("../../src/services/metrics.js");
    await server.inject({ method: "GET", url: "/metrics" });
    const value = await metricsScrapeRejectedTotal.get();
    const missingToken = value.values.find(
      (entry) => entry.labels.reason === "missing_token"
    );
    expect(missingToken?.value ?? 0).toBeGreaterThan(0);
  });
});
