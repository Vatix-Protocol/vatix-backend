import { describe, it, expect } from "vitest";
import {
  resolveOracleStellarConfig,
  validateAndResolveStellarConfig,
  IncompleteProductionStellarConfigError,
} from "../apps/workers/src/oracle/stellar-config.js";

const BASE_ENV = {
  STELLAR_RPC_URL: "https://rpc.example.com",
  SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ORACLE_SECRET_KEY: "S_SECRET",
  INDEXER_CONTRACT_ID: "CINDEXER",
};

describe("Production Stellar Config Validation — Fail-Fast Behavior", () => {
  it("development mode allows incomplete oracle config", () => {
    const incompleteDev = validateAndResolveStellarConfig(
      {
        SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
        ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
      },
      "development"
    );
    expect(incompleteDev).toBeUndefined();
  });

  it("test mode allows incomplete oracle config", () => {
    const incompleteTest = validateAndResolveStellarConfig(
      {
        SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
        ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
      },
      "test"
    );
    expect(incompleteTest).toBeUndefined();
  });

  it("production mode rejects missing RPC URL with clear error", () => {
    const error = expect(() =>
      validateAndResolveStellarConfig(
        {
          SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
          ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
          INDEXER_CONTRACT_ID: BASE_ENV.INDEXER_CONTRACT_ID,
        },
        "production"
      )
    ).toThrow(IncompleteProductionStellarConfigError);
    error.toThrow(/Missing:.*STELLAR_RPC_URL/);
  });

  it("production mode rejects missing contract ID with clear error", () => {
    const error = expect(() =>
      validateAndResolveStellarConfig(
        {
          STELLAR_RPC_URL: BASE_ENV.STELLAR_RPC_URL,
          SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
          ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
        },
        "production"
      )
    ).toThrow(IncompleteProductionStellarConfigError);
    error.toThrow(/Missing:.*contract ID/);
  });

  it("production mode rejects missing network passphrase with clear error", () => {
    const error = expect(() =>
      validateAndResolveStellarConfig(
        {
          STELLAR_RPC_URL: BASE_ENV.STELLAR_RPC_URL,
          ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
          INDEXER_CONTRACT_ID: BASE_ENV.INDEXER_CONTRACT_ID,
        },
        "production"
      )
    ).toThrow(IncompleteProductionStellarConfigError);
    error.toThrow(/Missing:.*SOROBAN_NETWORK_PASSPHRASE/);
  });

  it("production mode rejects missing signer secret with clear error", () => {
    const error = expect(() =>
      validateAndResolveStellarConfig(
        {
          STELLAR_RPC_URL: BASE_ENV.STELLAR_RPC_URL,
          SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
          INDEXER_CONTRACT_ID: BASE_ENV.INDEXER_CONTRACT_ID,
        },
        "production"
      )
    ).toThrow(IncompleteProductionStellarConfigError);
    error.toThrow(/Missing:.*ORACLE_SECRET_KEY/);
  });

  it("production mode with all required vars returns resolved config", () => {
    const config = validateAndResolveStellarConfig(BASE_ENV, "production");
    expect(config).toEqual({
      rpcUrl: BASE_ENV.STELLAR_RPC_URL,
      rpcUrls: [BASE_ENV.STELLAR_RPC_URL],
      contractId: BASE_ENV.INDEXER_CONTRACT_ID,
      networkPassphrase: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
      signerSecret: BASE_ENV.ORACLE_SECRET_KEY,
    });
  });

  it("production mode returns undefined in dev (production != development)", () => {
    const config = validateAndResolveStellarConfig(
      {
        SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
      },
      "development"
    );
    expect(config).toBeUndefined();
  });
});
