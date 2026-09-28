import { describe, it, expect } from "vitest";
import {
  ENV_NETWORK_MISMATCH,
  KNOWN_STELLAR_NETWORKS,
  StellarNetworkConfigError,
  assertHorizonMatchesNetwork,
  assertPassphraseMatchesDeployment,
  assertRpcMatchesNetwork,
  classifyNetworkPassphrase,
  validateStellarNetworkConsistency,
} from "./stellarNetwork.js";

const TESTNET = KNOWN_STELLAR_NETWORKS.testnet;
const MAINNET = KNOWN_STELLAR_NETWORKS.mainnet;

const MAINNET_HORIZON = "https://horizon.stellar.org";
const TESTNET_HORIZON = "https://horizon-testnet.stellar.org";
const MAINNET_RPC = "https://soroban.stellar.org";
const TESTNET_RPC = "https://soroban-testnet.stellar.org:443";

describe("classifyNetworkPassphrase", () => {
  it("maps the known passphrases to their network", () => {
    expect(classifyNetworkPassphrase(TESTNET)).toBe("testnet");
    expect(classifyNetworkPassphrase(MAINNET)).toBe("mainnet");
  });

  it("treats custom/blank passphrases as unknown", () => {
    expect(classifyNetworkPassphrase("Custom Network ; 2024")).toBe("unknown");
    expect(classifyNetworkPassphrase("")).toBe("unknown");
    expect(classifyNetworkPassphrase(undefined)).toBe("unknown");
  });
});

describe("assertPassphraseMatchesDeployment (#1133)", () => {
  it("accepts a passphrase that agrees with STELLAR_NETWORK", () => {
    expect(() =>
      assertPassphraseMatchesDeployment(TESTNET, "testnet")
    ).not.toThrow();
    expect(() =>
      assertPassphraseMatchesDeployment(MAINNET, "MAINNET")
    ).not.toThrow();
  });

  it("rejects testnet passphrase declared as mainnet", () => {
    expect(() => assertPassphraseMatchesDeployment(TESTNET, "mainnet")).toThrow(
      StellarNetworkConfigError
    );
  });

  it("carries the stable code and the variable name, never the value", () => {
    try {
      assertPassphraseMatchesDeployment(MAINNET, "testnet");
      throw new Error("expected a mismatch to throw");
    } catch (error) {
      const err = error as StellarNetworkConfigError;
      expect(err).toBeInstanceOf(StellarNetworkConfigError);
      expect(err.message).toContain(ENV_NETWORK_MISMATCH);
      expect(err.variable).toBe("SOROBAN_NETWORK_PASSPHRASE");
      expect(err.message).not.toContain(MAINNET);
    }
  });

  it("skips unrecognized deployment networks (futurenet, standalone)", () => {
    expect(() =>
      assertPassphraseMatchesDeployment("Custom Network ; 2024", "futurenet")
    ).not.toThrow();
    expect(() =>
      assertPassphraseMatchesDeployment(TESTNET, undefined)
    ).not.toThrow();
  });
});

describe("assertHorizonMatchesNetwork (#1134)", () => {
  it("accepts a public Horizon host on the matching network", () => {
    expect(() =>
      assertHorizonMatchesNetwork(TESTNET_HORIZON, TESTNET)
    ).not.toThrow();
    expect(() =>
      assertHorizonMatchesNetwork(MAINNET_HORIZON, MAINNET)
    ).not.toThrow();
  });

  it("rejects a mainnet Horizon host behind the testnet passphrase", () => {
    expect(() => assertHorizonMatchesNetwork(MAINNET_HORIZON, TESTNET)).toThrow(
      /ENV_NETWORK_MISMATCH/
    );
  });

  it("rejects a testnet Horizon host behind the mainnet passphrase", () => {
    expect(() => assertHorizonMatchesNetwork(TESTNET_HORIZON, MAINNET)).toThrow(
      StellarNetworkConfigError
    );
  });

  it("ignores self-hosted and unparseable hosts (no network signal)", () => {
    expect(() =>
      assertHorizonMatchesNetwork("http://localhost:8000", MAINNET)
    ).not.toThrow();
    expect(() =>
      assertHorizonMatchesNetwork("https://horizon.internal.corp", TESTNET)
    ).not.toThrow();
    expect(() =>
      assertHorizonMatchesNetwork("not a url", MAINNET)
    ).not.toThrow();
  });

  it("ignores custom passphrases (futurenet endpoints are not classified)", () => {
    expect(() =>
      assertHorizonMatchesNetwork(MAINNET_HORIZON, "Custom Network ; 2024")
    ).not.toThrow();
  });
});

describe("validateStellarNetworkConsistency", () => {
  it("accepts a fully consistent testnet configuration", () => {
    expect(() =>
      validateStellarNetworkConsistency({
        STELLAR_NETWORK: "testnet",
        SOROBAN_NETWORK_PASSPHRASE: TESTNET,
        STELLAR_HORIZON_URL: TESTNET_HORIZON,
        STELLAR_RPC_URL: TESTNET_RPC,
        STELLAR_RPC_URLS: `${TESTNET_RPC},http://localhost:8000`,
      })
    ).not.toThrow();
  });

  it("accepts a fully consistent mainnet configuration", () => {
    expect(() =>
      validateStellarNetworkConsistency({
        STELLAR_NETWORK: "mainnet",
        SOROBAN_NETWORK_PASSPHRASE: MAINNET,
        STELLAR_HORIZON_URL: MAINNET_HORIZON,
        STELLAR_RPC_URL: MAINNET_RPC,
      })
    ).not.toThrow();
  });

  it("rejects passphrase drift against STELLAR_NETWORK", () => {
    expect(() =>
      validateStellarNetworkConsistency({
        STELLAR_NETWORK: "mainnet",
        SOROBAN_NETWORK_PASSPHRASE: TESTNET,
      })
    ).toThrow(/ENV_NETWORK_MISMATCH/);
  });

  it("rejects a drifted Horizon URL", () => {
    expect(() =>
      validateStellarNetworkConsistency({
        SOROBAN_NETWORK_PASSPHRASE: TESTNET,
        STELLAR_HORIZON_URL: MAINNET_HORIZON,
      })
    ).toThrow(/STELLAR_HORIZON_URL/);
  });

  it("rejects a drifted entry anywhere in STELLAR_RPC_URLS, not just the first", () => {
    expect(() =>
      validateStellarNetworkConsistency({
        SOROBAN_NETWORK_PASSPHRASE: TESTNET,
        STELLAR_RPC_URLS: `${TESTNET_RPC},${MAINNET_RPC}`,
      })
    ).toThrow(/STELLAR_RPC_URLS/);
  });

  it("rejects a drifted entry anywhere in STELLAR_HORIZON_URLS", () => {
    expect(() =>
      validateStellarNetworkConsistency({
        SOROBAN_NETWORK_PASSPHRASE: MAINNET,
        STELLAR_HORIZON_URLS: `${MAINNET_HORIZON},${TESTNET_HORIZON}`,
      })
    ).toThrow(/STELLAR_HORIZON_URLS/);
  });

  it("checks endpoints against STELLAR_NETWORK when no passphrase is set", () => {
    expect(() =>
      validateStellarNetworkConsistency({
        STELLAR_NETWORK: "testnet",
        STELLAR_RPC_URL: MAINNET_RPC,
      })
    ).toThrow(/STELLAR_RPC_URL/);
  });

  it("is a no-op when nothing describes a known network", () => {
    expect(() =>
      validateStellarNetworkConsistency({
        STELLAR_NETWORK: "futurenet",
        SOROBAN_NETWORK_PASSPHRASE: "Custom Network ; 2024",
        STELLAR_RPC_URL: MAINNET_RPC,
        STELLAR_HORIZON_URL: TESTNET_HORIZON,
      })
    ).not.toThrow();
    expect(() => validateStellarNetworkConsistency({})).not.toThrow();
  });

  it("ignores blank env values", () => {
    expect(() =>
      validateStellarNetworkConsistency({
        STELLAR_NETWORK: "",
        SOROBAN_NETWORK_PASSPHRASE: "  ",
        STELLAR_RPC_URL: " ",
        STELLAR_HORIZON_URLS: "",
      })
    ).not.toThrow();
  });
});

describe("assertRpcMatchesNetwork (#1135)", () => {
  it("accepts public Soroban hosts on the matching network", () => {
    expect(() => assertRpcMatchesNetwork(TESTNET_RPC, TESTNET)).not.toThrow();
    expect(() => assertRpcMatchesNetwork(MAINNET_RPC, MAINNET)).not.toThrow();
  });

  it("rejects a testnet RPC host behind the mainnet passphrase", () => {
    expect(() => assertRpcMatchesNetwork(TESTNET_RPC, MAINNET)).toThrow(
      /ENV_NETWORK_MISMATCH/
    );
  });

  it("rejects the soroban-mainnet alias host behind the testnet passphrase", () => {
    expect(() =>
      assertRpcMatchesNetwork("https://soroban-mainnet.stellar.org", TESTNET)
    ).toThrow(StellarNetworkConfigError);
  });

  it("ignores self-hosted and unparseable hosts", () => {
    expect(() =>
      assertRpcMatchesNetwork("http://127.0.0.1:8000/soroban/rpc", MAINNET)
    ).not.toThrow();
    expect(() => assertRpcMatchesNetwork("nope", TESTNET)).not.toThrow();
  });
});

describe("assertRpcMatchesNetwork (#1135)", () => {
  it("accepts public Soroban hosts on the matching network", () => {
    expect(() => assertRpcMatchesNetwork(TESTNET_RPC, TESTNET)).not.toThrow();
    expect(() => assertRpcMatchesNetwork(MAINNET_RPC, MAINNET)).not.toThrow();
  });

  it("rejects a testnet RPC host behind the mainnet passphrase", () => {
    expect(() => assertRpcMatchesNetwork(TESTNET_RPC, MAINNET)).toThrow(
      /ENV_NETWORK_MISMATCH/
    );
  });

  it("rejects the soroban-mainnet alias host behind the testnet passphrase", () => {
    expect(() =>
      assertRpcMatchesNetwork("https://soroban-mainnet.stellar.org", TESTNET)
    ).toThrow(StellarNetworkConfigError);
  });

  it("ignores self-hosted and unparseable hosts", () => {
    expect(() =>
      assertRpcMatchesNetwork("http://127.0.0.1:8000/soroban/rpc", MAINNET)
    ).not.toThrow();
    expect(() => assertRpcMatchesNetwork("nope", TESTNET)).not.toThrow();
  });
});
