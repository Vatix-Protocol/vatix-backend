/**
 * Contract tests for the Prometheus scrape endpoint (#745).
 *
 * Ensures GET /metrics:
 * - is reachable and returns the Prometheus text exposition format
 * - includes default process/runtime metrics
 * - includes the orderbook hydrated-markets gauge (#746)
 * - includes matching leader, oracle fail-closed, and outbox orphan gauges (#962)
 * - is never rate-limited, like the health/ready probes
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/index.js";

describe("GET /metrics (#745)", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ||
      "postgresql://postgres:postgres@localhost:5433/vatix";
    server = buildServer({ logger: false, registerTestRoutes: false });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("is reachable and returns 200", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.statusCode).toBe(200);
  });

  it("returns the Prometheus text exposition content type", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.headers["content-type"]).toContain("text/plain");
  });

  it("includes default Node.js process metrics", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("vatix_process_cpu_user_seconds_total");
  });

  it("includes the orderbook hydrated-markets gauge (#746)", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("# TYPE vatix_orderbook_hydrated_markets gauge");
  });

  it("includes matching leader gauge (#962)", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("# TYPE vatix_matching_leader gauge");
  });

  it("includes oracle fail-closed counter (#962)", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("# TYPE vatix_oracle_fail_closed_total counter");
  });

  it("includes settlement outbox orphaned-trades gauge (#962)", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain(
      "# TYPE vatix_settlement_outbox_orphaned_trades gauge"
    );
  });

  it("includes settlement outbox depth gauge (#962)", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("# TYPE vatix_settlement_outbox_depth gauge");
  });

  it("includes settlement outbox lag seconds gauge (#962)", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain(
      "# TYPE vatix_settlement_outbox_lag_seconds gauge"
    );
  });

  it("exposes settlement lag as a histogram for alerting (#981)", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("# TYPE vatix_settlement_lag histogram");
  });

  it("exposes the instantaneous lag gauge alongside the histogram (#981)", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("# TYPE vatix_settlement_lag_current gauge");
  });

  it("exposes admission-control shed counter and shedding gauge (#981)", async () => {
    const res = await server.inject({ method: "GET", url: "/metrics" });
    expect(res.body).toContain("# TYPE vatix_orders_shed_total counter");
    expect(res.body).toContain("# TYPE vatix_admission_shedding gauge");
  });

  it("is never rate-limited, unlike ordinary routes", async () => {
    let lastStatus = 200;
    for (let i = 0; i < 150; i++) {
      const res = await server.inject({ method: "GET", url: "/metrics" });
      lastStatus = res.statusCode;
    }
    expect(lastStatus).toBe(200);
  });
});
