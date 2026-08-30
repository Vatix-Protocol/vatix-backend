import { describe, it, expect, afterEach } from "vitest";
import { buildIndexerHttpServer } from "./httpServer.js";

// Integration-style: exercises the real wiring (indexerCorsPlugin +
// marketsRoutes composed together), not just the CORS plugin registered
// against a stub route as apps/indexer/src/middleware/cors.test.ts does.
// This is the check that would have caught the routes/cors modules never
// being mounted anywhere in apps/indexer/src/main.ts.
describe("buildIndexerHttpServer", () => {
  afterEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    delete process.env.NODE_ENV;
  });

  it("rejects a disallowed origin against the real /markets route in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ALLOWED_ORIGINS;

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/markets",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
      },
    });

    expect(response.headers["access-control-allow-origin"]).not.toBe(
      "https://evil.example.com"
    );

    await app.close();
  });

  it("allows an allowlisted origin against the real /markets route in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ALLOWED_ORIGINS = "https://app.vatix.io";

    const app = await buildIndexerHttpServer();
    await app.ready();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/markets",
      headers: {
        origin: "https://app.vatix.io",
        "access-control-request-method": "GET",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "https://app.vatix.io"
    );

    await app.close();
  });
});
