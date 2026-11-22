import { describe, it, expect } from "vitest";
import {
  loadBaseConfig,
  loadIndexerConfig,
  loadOracleWorkerConfig,
  loadFinalizationConfig,
  ConfigValidationError,
  CONFIG_ERROR_CODES,
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

  describe("required secret validation", () => {
    const SECRET_VARS = ["ORACLE_SECRET_KEY", "API_KEY", "ADMIN_TOKEN"] as const;

    for (const variable of SECRET_VARS) {
      it(`throws on empty ${variable}`, () => {
        const env = { ...BASE_ENV, [variable]: "" };
        try {
          loadBaseConfig(env);
          throw new Error("expected to throw");
        } catch (err) {
          expect(err).toBeInstanceOf(ConfigValidationError);
          expect((err as ConfigValidationError).variable).toBe(variable);
          expect((err as Error).message).toContain(variable);
        }
      });

      it(`throws on whitespace-only ${variable}`, () => {
        const env = { ...BASE_ENV, [variable]: "   " };
        try {
          loadBaseConfig(env);
          throw new Error("expected to throw");
        } catch (err) {
          expect(err).toBeInstanceOf(ConfigValidationError);
          expect((err as ConfigValidationError).variable).toBe(variable);
          expect((err as Error).message).toContain(variable);
        }
      });

      it(`throws on whitespace-only ${variable} without leaking the value`, () => {
        const supplied = "   supersecretvalue   ";
        const env = { ...BASE_ENV, [variable]: supplied };
        try {
          loadBaseConfig(env);
          throw new Error("expected to throw");
        } catch (err) {
          expect(err).toBeInstanceOf(ConfigValidationError);
          expect((err as ConfigValidationError).variable).toBe(variable);
          expect((err as Error).message).toContain(variable);
          expect((err as Error).message).not.toContain(supplied);
          expect((err as Error).message).not.toContain("supersecretvalue");
        }
      });

      it(`accepts a valid non-blank ${variable}`, () => {
        const env = { ...BASE_ENV, [variable]: "  validvalue  " };
        expect(() => loadBaseConfig(env)).not.toThrow();
      });
    }
  });

  describe("NODE_ENV validation", () => {
    it("defaults to development when NODE_ENV is absent", () => {
      const config = loadBaseConfig(BASE_ENV);
      expect(config.nodeEnv).toBe("development");
    });

    it("defaults to development when NODE_ENV is empty", () => {
      const config = loadBaseConfig({ ...BASE_ENV, NODE_ENV: "" });
      expect(config.nodeEnv).toBe("development");
    });

    it("returns a valid NODE_ENV unchanged", () => {
      const config = loadBaseConfig({ ...BASE_ENV, NODE_ENV: "production" });
      expect(config.nodeEnv).toBe("production");
    });

    it("returns a valid NODE_ENV trimmed", () => {
      const config = loadBaseConfig({ ...BASE_ENV, NODE_ENV: "  test  " });
      expect(config.nodeEnv).toBe("test");
    });

    it("throws ENV_INVALID with variable NODE_ENV on an unknown value", () => {
      const env = { ...BASE_ENV, NODE_ENV: "prodction" };
      try {
        loadBaseConfig(env);
        throw new Error("expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        expect((err as ConfigValidationError).code).toBe(
          CONFIG_ERROR_CODES.ENV_INVALID
        );
        expect((err as ConfigValidationError).variable).toBe("NODE_ENV");
      }
    });
  });

  describe("LOG_LEVEL validation", () => {
    it("defaults to info when LOG_LEVEL is absent", () => {
      const config = loadBaseConfig(BASE_ENV);
      expect(config.logLevel).toBe("info");
    });

    it("defaults to info when LOG_LEVEL is empty", () => {
      const config = loadBaseConfig({ ...BASE_ENV, LOG_LEVEL: "" });
      expect(config.logLevel).toBe("info");
    });

    it("returns a valid LOG_LEVEL unchanged", () => {
      const config = loadBaseConfig({ ...BASE_ENV, LOG_LEVEL: "debug" });
      expect(config.logLevel).toBe("debug");
    });

    it("returns a valid LOG_LEVEL trimmed", () => {
      const config = loadBaseConfig({ ...BASE_ENV, LOG_LEVEL: "  warn  " });
      expect(config.logLevel).toBe("warn");
    });

    it("throws ENV_INVALID with variable LOG_LEVEL on an unknown value", () => {
      const env = { ...BASE_ENV, LOG_LEVEL: "verbose" };
      try {
        loadBaseConfig(env);
        throw new Error("expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        expect((err as ConfigValidationError).code).toBe(
          CONFIG_ERROR_CODES.ENV_INVALID
        );
        expect((err as ConfigValidationError).variable).toBe("LOG_LEVEL");
      }
    });
  });
});

describe("loadIndexerConfig", () => {
  const INDEXER_ENV = {
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    INDEXER_CONTRACT_ID: "CABC123",
    INDEXER_NETWORK_ID: "testnet",
  };

  it("loads valid indexer config with defaults", () => {
    const config = loadIndexerConfig(INDEXER_ENV);
    expect(config.stellarRpcUrl).toBe(INDEXER_ENV.STELLAR_RPC_URL);
    expect(config.contractId).toBe("CABC123");
    expect(config.ledgerWindowSize).toBe(100);
    expect(config.networkId).toBe("testnet");
    expect(config.cursorKey).toBe("ingestion");
  });

  it("accepts MARKET_CONTRACT_ID as alias", () => {
    const config = loadIndexerConfig({
      STELLAR_RPC_URL: INDEXER_ENV.STELLAR_RPC_URL,
      MARKET_CONTRACT_ID: "CMARKET",
      INDEXER_NETWORK_ID: "testnet",
    });
    expect(config.contractId).toBe("CMARKET");
  });

  it("throws on missing contract id", () => {
    expect(() =>
      loadIndexerConfig({
        STELLAR_RPC_URL: INDEXER_ENV.STELLAR_RPC_URL,
        INDEXER_NETWORK_ID: "testnet",
      })
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

  describe("INDEXER_NETWORK_ID validation", () => {
    it("throws when INDEXER_NETWORK_ID is absent", () => {
      const env = {
        STELLAR_RPC_URL: INDEXER_ENV.STELLAR_RPC_URL,
        INDEXER_CONTRACT_ID: INDEXER_ENV.INDEXER_CONTRACT_ID,
      };
      try {
        loadIndexerConfig(env);
        throw new Error("expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        expect((err as ConfigValidationError).variable).toBe(
          "INDEXER_NETWORK_ID"
        );
        expect((err as Error).message).toContain("INDEXER_NETWORK_ID");
      }
    });

    it("throws when INDEXER_NETWORK_ID is empty", () => {
      const env = { ...INDEXER_ENV, INDEXER_NETWORK_ID: "" };
      expect(() => loadIndexerConfig(env)).toThrow("INDEXER_NETWORK_ID");
    });

    it("throws when INDEXER_NETWORK_ID is unsupported", () => {
      const env = { ...INDEXER_ENV, INDEXER_NETWORK_ID: "devnet" };
      try {
        loadIndexerConfig(env);
        throw new Error("expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        expect((err as ConfigValidationError).variable).toBe(
          "INDEXER_NETWORK_ID"
        );
        expect((err as Error).message).toContain("INDEXER_NETWORK_ID");
      }
    });

    it("returns the explicitly supplied supported value", () => {
      const config = loadIndexerConfig({
        ...INDEXER_ENV,
        INDEXER_NETWORK_ID: "mainnet",
      });
      expect(config.networkId).toBe("mainnet");
    });
  });
});

describe("loadOracleWorkerConfig", () => {
  const ORACLE_ENV = {
    REDIS_URL: "redis://localhost:6379",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  };

  it("loads valid oracle worker config with defaults", () => {
    const config = loadOracleWorkerConfig(ORACLE_ENV);
    expect(config.submissionPollIntervalMs).toBe(5000);
    expect(config.submissionMaxRetries).toBe(3);
    expect(config.submissionVisibilityTimeoutMs).toBe(300_000);
    expect(config.logLevel).toBe("info");
    expect(config.redisUrl).toBe(ORACLE_ENV.REDIS_URL);
    expect(config.databaseUrl).toBe(ORACLE_ENV.DATABASE_URL);
  });

  it("honours explicit oracle worker overrides", () => {
    const config = loadOracleWorkerConfig({
      ...ORACLE_ENV,
      ORACLE_SUBMISSION_POLL_INTERVAL_MS: "2000",
      ORACLE_SUBMISSION_MAX_RETRIES: "5",
      ORACLE_SUBMISSION_VISIBILITY_TIMEOUT_MS: "60000",
      ORACLE_SUBMISSION_LOG_LEVEL: "debug",
    });
    expect(config.submissionPollIntervalMs).toBe(2000);
    expect(config.submissionMaxRetries).toBe(5);
    expect(config.submissionVisibilityTimeoutMs).toBe(60_000);
    expect(config.logLevel).toBe("debug");
  });

  it("throws when ORACLE_SUBMISSION_POLL_INTERVAL_MS is below minimum", () => {
    const env = { ...ORACLE_ENV, ORACLE_SUBMISSION_POLL_INTERVAL_MS: "10" };
    expect(() => loadOracleWorkerConfig(env)).toThrow(
      "ORACLE_SUBMISSION_POLL_INTERVAL_MS"
    );
  });

  it("throws on invalid ORACLE_SUBMISSION_LOG_LEVEL", () => {
    const env = { ...ORACLE_ENV, ORACLE_SUBMISSION_LOG_LEVEL: "verbose" };
    expect(() => loadOracleWorkerConfig(env)).toThrow(
      "ORACLE_SUBMISSION_LOG_LEVEL"
    );
  });

  it("throws on missing REDIS_URL", () => {
    expect(() =>
      loadOracleWorkerConfig({ DATABASE_URL: ORACLE_ENV.DATABASE_URL })
    ).toThrow("REDIS_URL");
  });

  it("throws on missing DATABASE_URL", () => {
    expect(() =>
      loadOracleWorkerConfig({ REDIS_URL: ORACLE_ENV.REDIS_URL })
    ).toThrow("DATABASE_URL");
  });

  it("throws on a non-postgres DATABASE_URL", () => {
    const env = { ...ORACLE_ENV, DATABASE_URL: "mysql://localhost:3306/db" };
    expect(() => loadOracleWorkerConfig(env)).toThrow("DATABASE_URL");
  });
});

describe("loadFinalizationConfig", () => {
  it("defaults the challenge window to the on-chain window", () => {
    const config = loadFinalizationConfig({});
    expect(config.intervalMs).toBe(60_000);
    expect(config.onChainChallengeWindowSeconds).toBe(86_400);
    expect(config.challengeWindowSeconds).toBe(86_400);
    expect(config.challengeWindowOverridden).toBe(false);
    expect(config.logLevel).toBe("info");
  });

  it("uses ORACLE_CHALLENGE_WINDOW_SECONDS as the canonical window", () => {
    const config = loadFinalizationConfig({
      ORACLE_CHALLENGE_WINDOW_SECONDS: "3600",
    });
    expect(config.onChainChallengeWindowSeconds).toBe(3600);
    expect(config.challengeWindowSeconds).toBe(3600);
    expect(config.challengeWindowOverridden).toBe(false);
  });

  it("allows a dev/test override and flags it", () => {
    const config = loadFinalizationConfig({
      ORACLE_CHALLENGE_WINDOW_SECONDS: "3600",
      FINALIZATION_CHALLENGE_WINDOW_SECONDS: "60",
    });
    expect(config.challengeWindowSeconds).toBe(60);
    expect(config.onChainChallengeWindowSeconds).toBe(3600);
    expect(config.challengeWindowOverridden).toBe(true);
  });

  it("rejects a production override that drifts from the on-chain window", () => {
    const env = {
      NODE_ENV: "production",
      ORACLE_CHALLENGE_WINDOW_SECONDS: "3600",
      FINALIZATION_CHALLENGE_WINDOW_SECONDS: "60",
    };
    expect(() => loadFinalizationConfig(env)).toThrow(
      "FINALIZATION_CHALLENGE_WINDOW_SECONDS"
    );
  });

  it("accepts a production override that matches the on-chain window", () => {
    const config = loadFinalizationConfig({
      NODE_ENV: "production",
      ORACLE_CHALLENGE_WINDOW_SECONDS: "3600",
      FINALIZATION_CHALLENGE_WINDOW_SECONDS: "3600",
    });
    expect(config.challengeWindowSeconds).toBe(3600);
    expect(config.challengeWindowOverridden).toBe(false);
  });

  it("throws when FINALIZATION_INTERVAL_MS is below minimum", () => {
    expect(() =>
      loadFinalizationConfig({ FINALIZATION_INTERVAL_MS: "10" })
    ).toThrow("FINALIZATION_INTERVAL_MS");
  });

  it("throws on invalid FINALIZATION_LOG_LEVEL", () => {
    expect(() =>
      loadFinalizationConfig({ FINALIZATION_LOG_LEVEL: "verbose" })
    ).toThrow("FINALIZATION_LOG_LEVEL");
  });
});

describe("loadBaseConfig optional fields", () => {
  it("applies documented defaults", () => {
    const config = loadBaseConfig(BASE_ENV);
    expect(config.bodyLimitBytes).toBe(65536);
    expect(config.stellarNetwork).toBe("testnet");
    expect(config.stellarHorizonUrl).toBe(
      "https://horizon-testnet.stellar.org"
    );
    expect(config.oracleChallengeWindowSeconds).toBe(86400);
    expect(config.auditStreamMaxlen).toBe(100_000);
    expect(config.rateLimiting.global).toEqual({
      windowMs: 60_000,
      maxRequests: 100,
    });
    expect(config.rateLimiting.heavy).toEqual({
      windowMs: 60_000,
      maxRequests: 20,
    });
    expect(config.rateLimiting.write).toEqual({
      windowMs: 60_000,
      maxRequests: 10,
    });
  });

  it("defaults CORS origins for development", () => {
    const config = loadBaseConfig(BASE_ENV);
    expect(config.corsAllowedOrigins).toEqual([
      "http://localhost:3000",
      "http://localhost:5173",
    ]);
  });

  it("parses a comma-separated CORS_ALLOWED_ORIGINS list", () => {
    const config = loadBaseConfig({
      ...BASE_ENV,
      CORS_ALLOWED_ORIGINS: "https://a.example, https://b.example",
    });
    expect(config.corsAllowedOrigins).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("rejects insecure CORS origins in production", () => {
    const env = {
      ...BASE_ENV,
      NODE_ENV: "production",
      CORS_ALLOWED_ORIGINS: "http://a.example",
    };
    expect(() => loadBaseConfig(env)).toThrow("CORS");
  });

  it("throws on a non-postgres DATABASE_URL", () => {
    const env = { ...BASE_ENV, DATABASE_URL: "mysql://localhost:3306/db" };
    expect(() => loadBaseConfig(env)).toThrow("DATABASE_URL");
  });

  it("throws on a non-redis REDIS_URL", () => {
    const env = { ...BASE_ENV, REDIS_URL: "http://localhost:6379" };
    expect(() => loadBaseConfig(env)).toThrow("REDIS_URL");
  });

  it("throws on a non-http STELLAR_RPC_URL", () => {
    const env = { ...BASE_ENV, STELLAR_RPC_URL: "ftp://rpc.example" };
    expect(() => loadBaseConfig(env)).toThrow("STELLAR_RPC_URL");
  });

  it("throws on a non-positive BODY_LIMIT_BYTES", () => {
    const env = { ...BASE_ENV, BODY_LIMIT_BYTES: "0" };
    expect(() => loadBaseConfig(env)).toThrow("BODY_LIMIT_BYTES");
  });

  it("throws on a non-positive AUDIT_STREAM_MAXLEN", () => {
    const env = { ...BASE_ENV, AUDIT_STREAM_MAXLEN: "-1" };
    expect(() => loadBaseConfig(env)).toThrow("AUDIT_STREAM_MAXLEN");
  });
});

describe("loadIndexerConfig optional fields", () => {
  const INDEXER_ENV = {
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    INDEXER_CONTRACT_ID: "CABC123",
    INDEXER_NETWORK_ID: "testnet",
  };

  it("applies documented defaults", () => {
    const config = loadIndexerConfig(INDEXER_ENV);
    expect(config.nodeEnv).toBe("development");
    expect(config.ingestionIntervalMs).toBe(5000);
    expect(config.batchSize).toBe(100);
    expect(config.checkpointFlushEveryBatches).toBe(10);
    expect(config.logLevel).toBe("info");
    expect(config.gapPauseThreshold).toBe(1000);
    expect(config.backfillMaxLedgers).toBe(500);
  });

  it("honours explicit overrides", () => {
    const config = loadIndexerConfig({
      ...INDEXER_ENV,
      INDEXER_INGESTION_INTERVAL_MS: "1000",
      INDEXER_LEDGER_WINDOW_SIZE: "50",
      INDEXER_BATCH_SIZE: "25",
      INDEXER_CURSOR_KEY: "custom",
      INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES: "5",
      INDEXER_LOG_LEVEL: "warn",
      INDEXER_GAP_PAUSE_THRESHOLD: "0",
      INDEXER_BACKFILL_MAX_LEDGERS: "100",
    });
    expect(config.ingestionIntervalMs).toBe(1000);
    expect(config.ledgerWindowSize).toBe(50);
    expect(config.batchSize).toBe(25);
    expect(config.cursorKey).toBe("custom");
    expect(config.checkpointFlushEveryBatches).toBe(5);
    expect(config.logLevel).toBe("warn");
    expect(config.gapPauseThreshold).toBe(0);
    expect(config.backfillMaxLedgers).toBe(100);
  });

  it("throws when INDEXER_LEDGER_WINDOW_SIZE exceeds max", () => {
    const env = { ...INDEXER_ENV, INDEXER_LEDGER_WINDOW_SIZE: "5000" };
    expect(() => loadIndexerConfig(env)).toThrow("INDEXER_LEDGER_WINDOW_SIZE");
  });

  it("throws when INDEXER_BATCH_SIZE exceeds max", () => {
    const env = { ...INDEXER_ENV, INDEXER_BATCH_SIZE: "1000" };
    expect(() => loadIndexerConfig(env)).toThrow("INDEXER_BATCH_SIZE");
  });

  it("throws on a negative INDEXER_GAP_PAUSE_THRESHOLD", () => {
    const env = { ...INDEXER_ENV, INDEXER_GAP_PAUSE_THRESHOLD: "-1" };
    expect(() => loadIndexerConfig(env)).toThrow("INDEXER_GAP_PAUSE_THRESHOLD");
  });

  it("throws on a non-positive INDEXER_BACKFILL_MAX_LEDGERS", () => {
    const env = { ...INDEXER_ENV, INDEXER_BACKFILL_MAX_LEDGERS: "0" };
    expect(() => loadIndexerConfig(env)).toThrow("INDEXER_BACKFILL_MAX_LEDGERS");
  });
});
