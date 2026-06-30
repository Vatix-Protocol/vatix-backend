import { describe, it, expect } from "vitest";
import fastify from "fastify";
import {
  getIndexerAllowedOrigins,
  indexerCorsPlugin,
  verifyIndexerCorsMatchesBaseConfig,
} from "./cors.js";

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  ORACLE_SECRET_KEY: "secret",
  API_KEY: "apikey",
  ADMIN_TOKEN: "admintoken",
};

describe("indexer CORS config (min-032)", () => {
  it("matches loadBaseConfig corsAllowedOrigins in development", () => {
    const result = verifyIndexerCorsMatchesBaseConfig({
      ...BASE_ENV,
      NODE_ENV: "development",
    });
    expect(result.matches).toBe(true);
    expect(result.indexerOrigins).toEqual([
      "http://localhost:3000",
      "http://localhost:5173",
    ]);
  });

  it("matches loadBaseConfig corsAllowedOrigins in production with no override", () => {
    const result = verifyIndexerCorsMatchesBaseConfig({
      ...BASE_ENV,
      NODE_ENV: "production",
    });
    expect(result.matches).toBe(true);
    expect(result.indexerOrigins).toEqual([]);
  });

  it("parses comma-separated CORS_ALLOWED_ORIGINS", () => {
    const origins = getIndexerAllowedOrigins(
      "production",
      "https://a.io, https://b.io"
    );
    expect(origins).toEqual(["https://a.io", "https://b.io"]);
  });

  it("registers CORS plugin and allows configured origin on preflight", async () => {
    const app = fastify({ logger: false });
    process.env.NODE_ENV = "development";
    process.env.CORS_ALLOWED_ORIGINS = "http://localhost:3000";

    await app.register(indexerCorsPlugin);
    app.get("/markets", async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/markets",
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "GET",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000"
    );

    await app.close();
  });
});
