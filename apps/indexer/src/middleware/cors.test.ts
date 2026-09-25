import { describe, it, expect, afterEach } from "vitest";
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

// ── #775: deny-by-default in production ──────────────────────────────────────
describe("indexer CORS — production deny-by-default (#775)", () => {
  afterEach(() => {
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  it("returns empty allowlist when NODE_ENV=production and no override is set", () => {
    const origins = getIndexerAllowedOrigins("production", undefined);
    expect(origins).toEqual([]);
  });

  it("rejects an arbitrary origin in production (no allowlist)", async () => {
    const app = fastify({ logger: false });
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ALLOWED_ORIGINS;

    await app.register(indexerCorsPlugin);
    app.get("/markets", async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/markets",
      headers: {
        origin: "https://evil.example.com",
        "access-control-request-method": "GET",
      },
    });

    // @fastify/cors responds with a 4xx or omits the ACAO header for rejected origins
    const acao = response.headers["access-control-allow-origin"];
    expect(acao).not.toBe("https://evil.example.com");

    await app.close();
  });

  it("allows an explicitly allowlisted production origin", async () => {
    const app = fastify({ logger: false });
    process.env.NODE_ENV = "production";
    process.env.CORS_ALLOWED_ORIGINS = "https://app.vatix.io";

    await app.register(indexerCorsPlugin);
    app.get("/markets", async () => ({ ok: true }));
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

  it("rejects an origin that is NOT in the production allowlist", async () => {
    const app = fastify({ logger: false });
    process.env.NODE_ENV = "production";
    process.env.CORS_ALLOWED_ORIGINS = "https://app.vatix.io";

    await app.register(indexerCorsPlugin);
    app.get("/markets", async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: "OPTIONS",
      url: "/markets",
      headers: {
        origin: "https://not-vatix.example.com",
        "access-control-request-method": "GET",
      },
    });

    const acao = response.headers["access-control-allow-origin"];
    expect(acao).not.toBe("https://not-vatix.example.com");

    await app.close();
  });

  it("does not reflect arbitrary origin back (no wildcard leak)", () => {
    // Any origin not in the list must not be in the resolved set
    const allowed = getIndexerAllowedOrigins(
      "production",
      "https://app.vatix.io"
    );
    expect(allowed).not.toContain("https://attacker.com");
    expect(allowed).not.toContain("*");
  });
});
