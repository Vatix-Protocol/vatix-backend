import { describe, it, expect } from "vitest";
import {
  loadBaseConfig,
  loadIndexerConfig,
  loadFinalizationConfig,
} from "./config.js";

const BASE_ENV = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  ORACLE_SECRET_KEY: "secret",
  API_KEY: "apikey",
  ADMIN_TOKEN: "admintoken",
};

describe("loadBaseConfig", () => {
  it("loads valid config without throwing", () => {
    const config = loadBaseConfig(BASE_ENV);
    expect(config.databaseUrl).toBe(BASE_ENV.DATABASE_URL);
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe("development");
  });

  it("throws on missing DATABASE_URL", () => {
    const env = { ...BASE_ENV, DATABASE_URL: undefined };
    expect(() => loadBaseConfig(env)).toThrow("DATABASE_URL");
  });

  it("throws on missing REDIS_URL", () => {
    const env = { ...BASE_ENV, REDIS_URL: undefined };
    expect(() => loadBaseConfig(env)).toThrow("REDIS_URL");
  });

  it("throws on missing ORACLE_SECRET_KEY", () => {
    const env = { ...BASE_ENV, ORACLE_SECRET_KEY: undefined };
    expect(() => loadBaseConfig(env)).toThrow("ORACLE_SECRET_KEY");
  });

  it("throws on invalid NODE_ENV", () => {
    const env = { ...BASE_ENV, NODE_ENV: "staging" };
    expect(() => loadBaseConfig(env)).toThrow("NODE_ENV");
  });

  it("throws on invalid PORT (non-integer)", () => {
    const env = { ...BASE_ENV, PORT: "abc" };
    expect(() => loadBaseConfig(env)).toThrow("PORT");
  });

  it("throws on PORT exceeding max (65535)", () => {
    const env = { ...BASE_ENV, PORT: "99999" };
    expect(() => loadBaseConfig(env)).toThrow("PORT");
  });

  it("uses PORT from env when provided", () => {
    const config = loadBaseConfig({ ...BASE_ENV, PORT: "4000" });
    expect(config.port).toBe(4000);
  });
});

describe("loadIndexerConfig", () => {
  const INDEXER_ENV = {
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  };

  it("loads valid indexer config with defaults", () => {
    const config = loadIndexerConfig(INDEXER_ENV);
    expect(config.stellarRpcUrl).toBe(INDEXER_ENV.STELLAR_RPC_URL);
    expect(config.networkId).toBe("mainnet");
    expect(config.cursorKey).toBe("ingestion");
  });

  it("throws on missing STELLAR_RPC_URL", () => {
    expect(() => loadIndexerConfig({})).toThrow("STELLAR_RPC_URL");
  });

  it("throws on invalid INDEXER_LOG_LEVEL", () => {
    const env = { ...INDEXER_ENV, INDEXER_LOG_LEVEL: "verbose" };
    expect(() => loadIndexerConfig(env)).toThrow("INDEXER_LOG_LEVEL");
  });

  it("throws when INDEXER_INGESTION_INTERVAL_MS is below minimum", () => {
    const env = { ...INDEXER_ENV, INDEXER_INGESTION_INTERVAL_MS: "10" };
    expect(() => loadIndexerConfig(env)).toThrow(
      "INDEXER_INGESTION_INTERVAL_MS"
    );
  });
});

describe("loadFinalizationConfig", () => {
  it("loads valid config with defaults", () => {
    const config = loadFinalizationConfig({});
    expect(config.intervalMs).toBe(60_000);
    expect(config.challengeWindowSeconds).toBe(3600);
    expect(config.logLevel).toBe("info");
  });

  it("reads FINALIZATION_INTERVAL_MS from env", () => {
    const config = loadFinalizationConfig({ FINALIZATION_INTERVAL_MS: "5000" });
    expect(config.intervalMs).toBe(5000);
  });

  it("throws when FINALIZATION_INTERVAL_MS is below minimum (1000)", () => {
    expect(() =>
      loadFinalizationConfig({ FINALIZATION_INTERVAL_MS: "500" })
    ).toThrow("FINALIZATION_INTERVAL_MS");
  });

  it("throws on invalid FINALIZATION_LOG_LEVEL", () => {
    expect(() =>
      loadFinalizationConfig({ FINALIZATION_LOG_LEVEL: "verbose" })
    ).toThrow("FINALIZATION_LOG_LEVEL");
  });

  it("reads FINALIZATION_CHALLENGE_WINDOW_SECONDS from env", () => {
    const config = loadFinalizationConfig({
      FINALIZATION_CHALLENGE_WINDOW_SECONDS: "7200",
    });
    expect(config.challengeWindowSeconds).toBe(7200);
  });

  it("throws when FINALIZATION_CHALLENGE_WINDOW_SECONDS is negative", () => {
    expect(() =>
      loadFinalizationConfig({ FINALIZATION_CHALLENGE_WINDOW_SECONDS: "-1" })
    ).toThrow("FINALIZATION_CHALLENGE_WINDOW_SECONDS");
  });
});
