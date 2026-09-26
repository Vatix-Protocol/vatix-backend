import { describe, it, expect } from "vitest";
import {
  loadBaseConfig,
  loadIndexerConfig,
  loadOracleWorkerConfig,
  loadFinalizationConfig,
  ConfigValidationError,
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
    INDEXER_CONTRACT_ID: "CABC123",
  };

  it("loads valid indexer config with defaults", () => {
    const config = loadIndexerConfig(INDEXER_ENV);
    expect(config.stellarRpcUrl).toBe(INDEXER_ENV.STELLAR_RPC_URL);
    expect(config.contractId).toBe("CABC123");
    expect(config.ledgerWindowSize).toBe(100);
    expect(config.networkId).toBe("mainnet");
    expect(config.cursorKey).toBe("ingestion");
  });

  it("accepts MARKET_CONTRACT_ID as alias", () => {
    const config = loadIndexerConfig({
      STELLAR_RPC_URL: INDEXER_ENV.STELLAR_RPC_URL,
      MARKET_CONTRACT_ID: "CMARKET",
    });
    expect(config.contractId).toBe("CMARKET");
  });

  it("throws on missing contract id", () => {
    expect(() =>
      loadIndexerConfig({ STELLAR_RPC_URL: INDEXER_ENV.STELLAR_RPC_URL })
    ).toThrow("INDEXER_CONTRACT_ID");
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

describe("loadOracleWorkerConfig", () => {
  const ORACLE_WORKER_ENV = {
    REDIS_URL: "redis://localhost:6379",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  };

  it("loads valid oracle worker config with defaults", () => {
    const config = loadOracleWorkerConfig(ORACLE_WORKER_ENV);
    expect(config.redisUrl).toBe(ORACLE_WORKER_ENV.REDIS_URL);
    expect(config.databaseUrl).toBe(ORACLE_WORKER_ENV.DATABASE_URL);
    expect(config.submissionPollIntervalMs).toBe(5000);
    expect(config.submissionMaxRetries).toBe(3);
    expect(config.submissionVisibilityTimeoutMs).toBe(300000);
    expect(config.logLevel).toBe("info");
  });

  it("throws on missing REDIS_URL", () => {
    const env = { ...ORACLE_WORKER_ENV, REDIS_URL: undefined };
    expect(() => loadOracleWorkerConfig(env)).toThrow("REDIS_URL");
  });

  it("throws on missing DATABASE_URL", () => {
    const env = { ...ORACLE_WORKER_ENV, DATABASE_URL: undefined };
    expect(() => loadOracleWorkerConfig(env)).toThrow("DATABASE_URL");
  });

  it("throws when ORACLE_SUBMISSION_POLL_INTERVAL_MS is below minimum", () => {
    const env = {
      ...ORACLE_WORKER_ENV,
      ORACLE_SUBMISSION_POLL_INTERVAL_MS: "100",
    };
    expect(() => loadOracleWorkerConfig(env)).toThrow(
      "ORACLE_SUBMISSION_POLL_INTERVAL_MS"
    );
  });
});

describe("loadFinalizationConfig", () => {
  it("loads valid finalization config with defaults", () => {
    const config = loadFinalizationConfig({});
    expect(config.intervalMs).toBe(60000);
    // Defaults to the on-chain window (ORACLE_CHALLENGE_WINDOW_SECONDS), not a stub.
    expect(config.challengeWindowSeconds).toBe(86400);
    expect(config.onChainChallengeWindowSeconds).toBe(86400);
    expect(config.challengeWindowOverridden).toBe(false);
    expect(config.logLevel).toBe("info");
  });

  it("throws when FINALIZATION_INTERVAL_MS is below minimum", () => {
    const env = { FINALIZATION_INTERVAL_MS: "500" };
    expect(() => loadFinalizationConfig(env)).toThrow(
      "FINALIZATION_INTERVAL_MS"
    );
  });

  it("throws on invalid FINALIZATION_LOG_LEVEL", () => {
    const env = { FINALIZATION_LOG_LEVEL: "verbose" };
    expect(() => loadFinalizationConfig(env)).toThrow("FINALIZATION_LOG_LEVEL");
  });

  // Issue #950: the finalization challenge window must match the on-chain
  // resolution contract window (ORACLE_CHALLENGE_WINDOW_SECONDS).
  describe("challenge window / on-chain contract drift", () => {
    it("defaults challengeWindowSeconds to ORACLE_CHALLENGE_WINDOW_SECONDS when no override is set", () => {
      const config = loadFinalizationConfig({
        ORACLE_CHALLENGE_WINDOW_SECONDS: "43200",
      });
      expect(config.challengeWindowSeconds).toBe(43200);
      expect(config.onChainChallengeWindowSeconds).toBe(43200);
      expect(config.challengeWindowOverridden).toBe(false);
    });

    it("throws in production when FINALIZATION_CHALLENGE_WINDOW_SECONDS drifts from the on-chain window", () => {
      const env = {
        NODE_ENV: "production",
        ORACLE_CHALLENGE_WINDOW_SECONDS: "86400",
        FINALIZATION_CHALLENGE_WINDOW_SECONDS: "3600",
      };
      expect(() => loadFinalizationConfig(env)).toThrow(ConfigValidationError);
      expect(() => loadFinalizationConfig(env)).toThrow(
        "must match the on-chain resolution contract window"
      );
    });

    it("allows a matching override in production", () => {
      const config = loadFinalizationConfig({
        NODE_ENV: "production",
        ORACLE_CHALLENGE_WINDOW_SECONDS: "86400",
        FINALIZATION_CHALLENGE_WINDOW_SECONDS: "86400",
      });
      expect(config.challengeWindowSeconds).toBe(86400);
      expect(config.challengeWindowOverridden).toBe(false);
    });

    it("allows a drifting override outside production but flags it", () => {
      const config = loadFinalizationConfig({
        NODE_ENV: "development",
        ORACLE_CHALLENGE_WINDOW_SECONDS: "86400",
        FINALIZATION_CHALLENGE_WINDOW_SECONDS: "3600",
      });
      expect(config.challengeWindowSeconds).toBe(3600);
      expect(config.onChainChallengeWindowSeconds).toBe(86400);
      expect(config.challengeWindowOverridden).toBe(true);
    });
  });
});

describe("ConfigValidationError", () => {
  it("has statusCode 400 on invalid input", () => {
    const env = { ...BASE_ENV, NODE_ENV: "invalid" };
    try {
      loadBaseConfig(env);
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).statusCode).toBe(400);
    }
  });

  it("has statusCode 400 when DATABASE_URL is missing", () => {
    const env = { ...BASE_ENV, DATABASE_URL: undefined };
    expect(() => loadBaseConfig(env)).toThrow(ConfigValidationError);
    try {
      loadBaseConfig(env);
    } catch (err) {
      expect((err as ConfigValidationError).statusCode).toBe(400);
    }
  });
});
