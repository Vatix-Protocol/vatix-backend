import { describe, it, expect } from "vitest";
import {
  resolveOracleStellarConfig,
  validateAndResolveStellarConfig,
  assertPassphraseMatchesDeployment,
  StellarNetworkMismatchError,
  IncompleteProductionStellarConfigError,
} from "./stellar-config.js";
import {
  ENV_NETWORK_MISMATCH,
  StellarNetworkConsistencyError,
} from "../../../../packages/shared/src/networkConsistency.js";

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
      rpcUrls: [BASE_ENV.STELLAR_RPC_URL],
      contractId: "CINDEXER",
      networkPassphrase: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
      signerSecret: BASE_ENV.ORACLE_SECRET_KEY,
    });
  });

  it("defaults STELLAR_NETWORK to testnet and accepts the matching testnet passphrase", () => {
    const config = resolveOracleStellarConfig({
      ...BASE_ENV,
      INDEXER_CONTRACT_ID: "CINDEXER",
    });
    expect(config?.networkPassphrase).toBe("Test SDF Network ; September 2015");
  });

  it("throws when the passphrase does not match the declared deployment network", () => {
    expect(() =>
      resolveOracleStellarConfig({
        ...BASE_ENV,
        INDEXER_CONTRACT_ID: "CINDEXER",
        STELLAR_NETWORK: "mainnet",
      })
    ).toThrow(StellarNetworkMismatchError);
  });

  it("accepts the mainnet passphrase when STELLAR_NETWORK=mainnet", () => {
    const config = resolveOracleStellarConfig({
      ...BASE_ENV,
      INDEXER_CONTRACT_ID: "CINDEXER",
      STELLAR_NETWORK: "mainnet",
      SOROBAN_NETWORK_PASSPHRASE:
        "Public Global Stellar Network ; September 2015",
    });
    expect(config?.networkPassphrase).toBe(
      "Public Global Stellar Network ; September 2015"
    );
  });

  it("does not validate when the config is otherwise incomplete", () => {
    const config = resolveOracleStellarConfig({
      SOROBAN_NETWORK_PASSPHRASE: "not a real passphrase",
      ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
      STELLAR_NETWORK: "mainnet",
      // STELLAR_RPC_URL and a contract id are missing, so resolution should
      // short-circuit to undefined before the mismatch check ever runs.
    });
    expect(config).toBeUndefined();
  });
});

describe("network consistency gate — every environment (#1133, #1134, #1135)", () => {
  const COHERENT_TESTNET = {
    ...BASE_ENV,
    INDEXER_CONTRACT_ID: "CINDEXER",
    STELLAR_NETWORK: "testnet",
    STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  };

  it("resolves a coherent testnet deployment (no false positive)", () => {
    const config = resolveOracleStellarConfig(COHERENT_TESTNET);
    expect(config?.rpcUrl).toBe("https://soroban-testnet.stellar.org");
  });

  it("rejects a mainnet Horizon URL on a testnet deployment, outside production", () => {
    // Regression: outside production the worker only ran the passphrase and RPC
    // checks, so a half-rotated deployment (testnet passphrase, mainnet
    // Horizon) booted the on-chain signer with ENV_NETWORK_MISMATCH never
    // raised for STELLAR_HORIZON_URL (#1134).
    let thrown: unknown;
    try {
      resolveOracleStellarConfig({
        ...COHERENT_TESTNET,
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(StellarNetworkConsistencyError);
    expect((thrown as StellarNetworkConsistencyError).code).toBe(
      ENV_NETWORK_MISMATCH
    );
    expect((thrown as StellarNetworkConsistencyError).variable).toBe(
      "STELLAR_HORIZON_URL"
    );
    // Fail-closed messages carry the variable name, never the URL or passphrase.
    expect((thrown as Error).message).not.toContain("Test SDF Network");
  });

  it("rejects drift hidden in the endpoint variable the worker does not prefer", () => {
    expect(() =>
      resolveOracleStellarConfig({
        ...COHERENT_TESTNET,
        STELLAR_RPC_URLS: "https://soroban-mainnet.stellar.org",
      })
    ).toThrow(/STELLAR_RPC_URLS/);
  });

  it("still raises the oracle worker's own error type for passphrase drift", () => {
    expect(() =>
      resolveOracleStellarConfig({
        ...COHERENT_TESTNET,
        STELLAR_NETWORK: "mainnet",
      })
    ).toThrow(StellarNetworkMismatchError);
  });

  it("exempts custom networks and non-Stellar hosts", () => {
    const config = resolveOracleStellarConfig({
      ...COHERENT_TESTNET,
      STELLAR_NETWORK: "futurenet",
      SOROBAN_NETWORK_PASSPHRASE: "Test SDF Future Network ; October 2022",
      STELLAR_HORIZON_URL: "https://horizon-futurenet.stellar.org",
      STELLAR_RPC_URL: "https://rpc.example.com",
    });
    expect(config?.rpcUrl).toBe("https://rpc.example.com");
  });

  it("gates the dev/test path of validateAndResolveStellarConfig too", () => {
    expect(() =>
      validateAndResolveStellarConfig(
        {
          ...COHERENT_TESTNET,
          STELLAR_HORIZON_URL: "https://horizon.stellar.org",
        },
        "development"
      )
    ).toThrow(/ENV_NETWORK_MISMATCH/);
  });
});

describe("assertPassphraseMatchesDeployment", () => {
  it("rejects a wrong passphrase for a known deployment network", () => {
    expect(() =>
      assertPassphraseMatchesDeployment(
        "Test SDF Network ; September 2015",
        "mainnet"
      )
    ).toThrow(/does not match STELLAR_NETWORK="mainnet"/);
  });

  it("accepts the correct passphrase for a known deployment network", () => {
    expect(() =>
      assertPassphraseMatchesDeployment(
        "Test SDF Network ; September 2015",
        "testnet"
      )
    ).not.toThrow();
  });

  it("is case-insensitive and trims the deployment network identifier", () => {
    expect(() =>
      assertPassphraseMatchesDeployment(
        "Test SDF Network ; September 2015",
        "  Testnet  "
      )
    ).not.toThrow();
  });

  it("does not throw for an unrecognized deployment network", () => {
    expect(() =>
      assertPassphraseMatchesDeployment(
        "Standalone Network ; 2024",
        "futurenet"
      )
    ).not.toThrow();
  });
});

describe("validateAndResolveStellarConfig", () => {
  it("returns undefined in development when config is incomplete", () => {
    const config = validateAndResolveStellarConfig(
      {
        SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
        ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
      },
      "development"
    );
    expect(config).toBeUndefined();
  });

  it("returns undefined in test when config is incomplete", () => {
    const config = validateAndResolveStellarConfig(
      {
        SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
        ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
      },
      "test"
    );
    expect(config).toBeUndefined();
  });

  it("throws in production when RPC URL is missing", () => {
    expect(() =>
      validateAndResolveStellarConfig(
        {
          SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
          ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
          INDEXER_CONTRACT_ID: "CINDEXER",
        },
        "production"
      )
    ).toThrow(IncompleteProductionStellarConfigError);
  });

  it("throws in production when contract ID is missing", () => {
    expect(() =>
      validateAndResolveStellarConfig(
        {
          ...BASE_ENV,
        },
        "production"
      )
    ).toThrow(IncompleteProductionStellarConfigError);
  });

  it("throws in production when network passphrase is missing", () => {
    expect(() =>
      validateAndResolveStellarConfig(
        {
          STELLAR_RPC_URL: BASE_ENV.STELLAR_RPC_URL,
          ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
          INDEXER_CONTRACT_ID: "CINDEXER",
        },
        "production"
      )
    ).toThrow(IncompleteProductionStellarConfigError);
  });

  it("throws in production when signer secret is missing", () => {
    expect(() =>
      validateAndResolveStellarConfig(
        {
          STELLAR_RPC_URL: BASE_ENV.STELLAR_RPC_URL,
          SOROBAN_NETWORK_PASSPHRASE: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
          INDEXER_CONTRACT_ID: "CINDEXER",
        },
        "production"
      )
    ).toThrow(IncompleteProductionStellarConfigError);
  });

  it("returns resolved config in production when all required vars are present", () => {
    const config = validateAndResolveStellarConfig(
      {
        ...BASE_ENV,
        INDEXER_CONTRACT_ID: "CINDEXER",
      },
      "production"
    );
    expect(config).toEqual({
      rpcUrl: BASE_ENV.STELLAR_RPC_URL,
      rpcUrls: [BASE_ENV.STELLAR_RPC_URL],
      contractId: "CINDEXER",
      networkPassphrase: BASE_ENV.SOROBAN_NETWORK_PASSPHRASE,
      signerSecret: BASE_ENV.ORACLE_SECRET_KEY,
    });
  });

  it("throws in production with a clear error message listing missing vars", () => {
    expect(() =>
      validateAndResolveStellarConfig(
        {
          ORACLE_SECRET_KEY: BASE_ENV.ORACLE_SECRET_KEY,
        },
        "production"
      )
    ).toThrow(
      /Missing:.*STELLAR_RPC_URL.*contract ID.*SOROBAN_NETWORK_PASSPHRASE/
    );
  });
});
