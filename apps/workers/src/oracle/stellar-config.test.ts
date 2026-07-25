import { describe, it, expect } from "vitest";
import { resolveOracleStellarConfig } from "./stellar-config.js";

const BASE_ENV = {
  STELLAR_RPC_URL: "https://rpc.example.com",
  SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  ORACLE_SECRET_KEY: "S_SECRET",
};

describe("resolveOracleStellarConfig", () => {
  it("prefers INDEXER_CONTRACT_ID over the legacy MARKET_CONTRACT_ID alias", () => {
    const config = resolveOracleStellarConfig({
      ...BASE_ENV,
      INDEXER_CONTRACT_ID: "CINDEXER",
      MARKET_CONTRACT_ID: "CMARKET",
    });
    expect(config?.contractId).toBe("CINDEXER");
  });

  it("falls back to MARKET_CONTRACT_ID when INDEXER_CONTRACT_ID is absent", () => {
    const config = resolveOracleStellarConfig({
      ...BASE_ENV,
      MARKET_CONTRACT_ID: "CMARKET",
    });
    expect(config?.contractId).toBe("CMARKET");
  });

  it("returns undefined when neither contract id var is set", () => {
    const config = resolveOracleStellarConfig({ ...BASE_ENV });
    expect(config).toBeUndefined();
  });

  it("returns undefined when STELLAR_RPC_URL is missing", () => {
    const config = resolveOracleStellarConfig({
      SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
      ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
      INDEXER_CONTRACT_ID: "CINDEXER",
    });
    expect(config).toBeUndefined();
  });

  it("returns the full config when all required vars are present", () => {
    const config = resolveOracleStellarConfig({
      ...BASE_ENV,
      INDEXER_CONTRACT_ID: "CINDEXER",
    });
    expect(config).toEqual({
      rpcUrl: BASE_ENV.STELLAR_RPC_URL,
      contractId: "CINDEXER",
      networkPassphrase: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
      signerSecret: BASE_ENV.ORACLE_SECRET_KEY,
    });
  });
});
