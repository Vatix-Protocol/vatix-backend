import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, getConfig, resetConfig } from "./config.js";

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/vatix",
  ORACLE_SECRET_KEY: "SABC123",
};

describe("loadConfig", () => {
  it("returns defaults for optional vars", () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.server.port).toBe(3000);
    expect(cfg.server.nodeEnv).toBe("development");
    expect(cfg.redis.url).toBe("redis://localhost:6379");
    expect(cfg.stellar.network).toBe("testnet");
    expect(cfg.oracle.challengeWindowSeconds).toBe(86400);
    expect(cfg.rateLimit.max).toBe(100);
    expect(cfg.indexer.logLevel).toBe("info");
    expect(cfg.indexer.networkId).toBe("mainnet");
  });

  it("reads overridden values from env", () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      PORT: "4000",
      NODE_ENV: "production",
      REDIS_URL: "redis://redis:6380",
      ORACLE_CHALLENGE_WINDOW_SECONDS: "3600",
      RATE_LIMIT_MAX: "50",
      INDEXER_LOG_LEVEL: "debug",
      INDEXER_NETWORK_ID: "testnet",
    });
    expect(cfg.server.port).toBe(4000);
    expect(cfg.server.nodeEnv).toBe("production");
    expect(cfg.redis.url).toBe("redis://redis:6380");
    expect(cfg.oracle.challengeWindowSeconds).toBe(3600);
    expect(cfg.rateLimit.max).toBe(50);
    expect(cfg.indexer.logLevel).toBe("debug");
    expect(cfg.indexer.networkId).toBe("testnet");
  });

  it("throws when DATABASE_URL is missing", () => {
    expect(() => loadConfig({})).toThrow("DATABASE_URL");
  });

  it("throws on invalid PORT", () => {
    expect(() => loadConfig({ ...BASE_ENV, PORT: "abc" })).toThrow("PORT");
  });

  it("throws on invalid NODE_ENV", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, NODE_ENV: "staging" })
    ).toThrow("NODE_ENV");
  });

  it("throws on invalid INDEXER_LOG_LEVEL", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, INDEXER_LOG_LEVEL: "verbose" })
    ).toThrow("INDEXER_LOG_LEVEL");
  });

  it("throws when INDEXER_INGESTION_INTERVAL_MS is zero", () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, INDEXER_INGESTION_INTERVAL_MS: "0" })
    ).toThrow("INDEXER_INGESTION_INTERVAL_MS");
  });
});

describe("getConfig / resetConfig", () => {
  beforeEach(() => resetConfig());

  it("returns the same instance on repeated calls", () => {
    process.env.DATABASE_URL = BASE_ENV.DATABASE_URL!;
    process.env.ORACLE_SECRET_KEY = BASE_ENV.ORACLE_SECRET_KEY!;
    const a = getConfig();
    const b = getConfig();
    expect(a).toBe(b);
    delete process.env.DATABASE_URL;
    delete process.env.ORACLE_SECRET_KEY;
  });
});
