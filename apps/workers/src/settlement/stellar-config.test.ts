import { describe, it, expect } from "vitest";
import {
  validateSettlementStellarConfig,
  IncompleteProductionSettlementConfigError,
} from "./stellar-config.js";
import { StellarNetworkConsistencyError } from "../../../../packages/shared/src/networkConsistency.js";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

/** A fully valid, internally consistent testnet settlement config. */
function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    STELLAR_NETWORK: "testnet",
    SOROBAN_NETWORK_PASSPHRASE: TESTNET,
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    SETTLEMENT_CONTRACT_ID: "CTESTCONTRACT",
    STELLAR_SECRET_KEY: "S_SETTLEMENT_SECRET",
    ...overrides,
  };
}

describe("validateSettlementStellarConfig — network consistency gate", () => {
  // Regression: the settlement worker resolved its RPC URL with
  // loadStellarEndpoints() but never called assertStellarNetworkConsistency(),
  // so it booted and signed/submitted against a chain that did not match its
  // passphrase. #1133/#1134/#1135.
  it("rejects a testnet passphrase paired with a mainnet RPC URL", () => {
    expect(() =>
      validateSettlementStellarConfig(
        validEnv({ STELLAR_RPC_URL: "https://soroban.stellar.org" }),
        "production"
      )
    ).toThrow(StellarNetworkConsistencyError);
  });

  it("rejects drift in production", () => {
    expect(() =>
      validateSettlementStellarConfig(
        validEnv({ STELLAR_RPC_URL: "https://soroban-mainnet.stellar.org" }),
        "production"
      )
    ).toThrow(/ENV_NETWORK_MISMATCH/);
  });

  it("rejects drift in dev/test too — a drifted settlement worker is a money-path failure", () => {
    // The other boot gates (API, indexer, oracle) fail closed in every
    // environment; settlement must not be the one that only guards production.
    expect(() =>
      validateSettlementStellarConfig(
        validEnv({ STELLAR_RPC_URL: "https://soroban.stellar.org" }),
        "development"
      )
    ).toThrow(StellarNetworkConsistencyError);
  });

  it("rejects a drifted secondary entry in STELLAR_RPC_URLS", () => {
    expect(() =>
      validateSettlementStellarConfig(
        validEnv({
          STELLAR_RPC_URLS:
            "https://soroban-testnet.stellar.org,https://soroban.stellar.org",
        }),
        "production"
      )
    ).toThrow(/STELLAR_RPC_URLS/);
  });

  it("rejects a passphrase that disagrees with STELLAR_NETWORK (#1133)", () => {
    expect(() =>
      validateSettlementStellarConfig(
        validEnv({
          STELLAR_NETWORK: "mainnet",
          SOROBAN_NETWORK_PASSPHRASE: TESTNET,
        }),
        "production"
      )
    ).toThrow(/ENV_NETWORK_MISMATCH/);
  });

  it("accepts a consistent testnet config and resolves the RPC URL", () => {
    const cfg = validateSettlementStellarConfig(validEnv(), "production");
    expect(cfg?.rpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(cfg?.contractId).toBe("CTESTCONTRACT");
  });

  it("accepts a consistent mainnet config", () => {
    const cfg = validateSettlementStellarConfig(
      validEnv({
        STELLAR_NETWORK: "mainnet",
        SOROBAN_NETWORK_PASSPHRASE: MAINNET,
        STELLAR_RPC_URL: "https://soroban.stellar.org",
      }),
      "production"
    );
    expect(cfg?.rpcUrl).toBe("https://soroban.stellar.org");
  });

  it("still permits self-hosted endpoints (no network signal to verify)", () => {
    const cfg = validateSettlementStellarConfig(
      validEnv({ STELLAR_RPC_URL: "http://localhost:8000" }),
      "production"
    );
    expect(cfg?.rpcUrl).toBe("http://localhost:8000");
  });

  it("keeps the existing incomplete-config failure for production", () => {
    const { STELLAR_SECRET_KEY: _omit, ...incomplete } = validEnv();
    expect(() =>
      validateSettlementStellarConfig(incomplete, "production")
    ).toThrow(IncompleteProductionSettlementConfigError);
  });

  it("keeps the lenient dev/test behaviour for incomplete config", () => {
    expect(validateSettlementStellarConfig({}, "development")).toBeUndefined();
  });
});
