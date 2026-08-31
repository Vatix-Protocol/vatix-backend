import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { liveRoutes } from "./live.js";

function buildServer() {
  const server = Fastify({ logger: false });
  server.register(liveRoutes);
  return server;
}

describe("GET /live (workers)", () => {
  it("always returns 200 live:true with no dependency checks", async () => {
    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/live" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.live).toBe(true);
    expect(body.service).toBe("vatix-workers");
  });

  it("echoes a supplied x-request-id for log correlation", async () => {
    const server = buildServer();
    const res = await server.inject({
      method: "GET",
      url: "/live",
      headers: { "x-request-id": "test-correlation-id" },
    });

    expect(res.headers["x-request-id"]).toBe("test-correlation-id");
  });

  it("generates a request id when none is supplied", async () => {
    const server = buildServer();
    const res = await server.inject({ method: "GET", url: "/live" });

    expect(res.headers["x-request-id"]).toBeTruthy();
  });
});
