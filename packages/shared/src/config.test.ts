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

describe("loadOracleWorkerConfig", () => 

/* … truncated 2021 chars — edit only what you need near the top … */
