import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ENV_NETWORK_MISMATCH,
  KNOWN_NETWORK_PASSPHRASES,
  StellarNetworkConsistencyError,
  assertEndpointMatchesNetwork,
  assertNetworkPassphraseMatches,
  assertStellarNetworkConsistency,
  collectUnverifiableEndpointWarnings,
  endpointHostname,
  isKnownStellarNetwork,
  knownPassphraseForNetwork,
  normalizeStellarNetwork,
  warnUnverifiableStellarEndpoints,
} from "./networkConsistency.js";

const TESTNET = KNOWN_NETWORK_PASSPHRASES.testnet;
const MAINNET = KNOWN_NETWORK_PASSPHRASES.mainnet;

describe("normalizeStellarNetwork", () => {
  it("defaults to testnet when unset (matches .env.example)", () => {
    expect(normalizeStellarNetwork(undefined)).toBe("testnet");
    expect(normalizeStellarNetwork("")).toBe("testnet");
    expect(normalizeStellarNetwork("   ")).toBe("testnet");
  });

  it("trims and lowercases", () => {
    expect(normalizeStellarNetwork("  MainNet ")).toBe("mainnet");
  });

  it("keeps custom networks as-is", () => {
    expect(normalizeStellarNetwork("futurenet")).toBe("futurenet");
    expect(isKnownStellarNetwork("futurenet")).toBe(false);
    expect(knownPassphraseForNetwork("futurenet")).toBeUndefined();
  });
});

describe("endpointHostname", () => {
  it("lowercases and strips trailing dots so the allowlist cannot be bypassed", () => {
    expect(endpointHostname("https://Horizon.stellar.org./")).toBe(
      "horizon.stellar.org"
    );
  });

  it("returns undefined for an unparseable URL", () => {
    expect(endpointHostname("not-a-url")).toBeUndefined();
  });
});

// #1133 — network passphrase consistency
describe("assertNetworkPassphraseMatches", () => {
  it("accepts the published passphrase for the declared network", () => {
    expect(() =>
      assertNetworkPassphraseMatches(TESTNET, "testnet")
    ).not.toThrow();
    expect(() =>
      assertNetworkPassphraseMatches(MAINNET, "mainnet")
    ).not.toThrow();
  });

  it("is case/space insensitive about the network id", () => {
    expect(() =>
      assertNetworkPassphraseMatches(MAINNET, "  MainNet ")
    ).not.toThrow();
  });

  it("rejects a mainnet passphrase declared as testnet", () => {
    expect(() => assertNetworkPassphraseMatches(MAINNET, "testnet")).toThrow(
      StellarNetworkConsistencyError
    );
  });

  it("rejects a testnet passphrase declared as mainnet", () => {
    expect(() => assertNetworkPassphraseMatches(TESTNET, "mainnet")).toThrow(
      /ENV_NETWORK_MISMATCH.*STELLAR_NETWORK="mainnet"/s
    );
  });

  it("skips custom networks (no published passphrase to compare)", () => {
    expect(() =>
      assertNetworkPassphraseMatches(
        "Some Custom Net ; January 2024",
        "futurenet"
      )
    ).not.toThrow();
  });

  it("never embeds the passphrase value in the error", () => {
    const secretLooking = "leaked-passphrase-value";
    let thrown: unknown;
    try {
      assertNetworkPassphraseMatches(secretLooking, "testnet");
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).not.toContain(secretLooking);
    expect((thrown as StellarNetworkConsistencyError).code).toBe(
      ENV_NETWORK_MISMATCH
    );
    expect((thrown as StellarNetworkConsistencyError).variable).toBe(
      "SOROBAN_NETWORK_PASSPHRASE"
    );
  });
});

// #1134 — Horizon URL matches network
describe("assertEndpointMatchesNetwork (horizon)", () => {
  it("accepts the testnet Horizon URL for testnet", () => {
    expect(() =>
      assertEndpointMatchesNetwork(
        "https://horizon-testnet.stellar.org",
        "testnet",
        "horizon",
        "STELLAR_HORIZON_URL"
      )
    ).not.toThrow();
  });

  it("accepts the mainnet Horizon URL for mainnet", () => {
    expect(() =>
      assertEndpointMatchesNetwork(
        "https://horizon.stellar.org",
        "mainnet",
        "horizon",
        "STELLAR_HORIZON_URL"
      )
    ).not.toThrow();
  });

  it("rejects the mainnet Horizon URL when the network is testnet", () => {
    expect(() =>
      assertEndpointMatchesNetwork(
        "https://horizon.stellar.org",
        "testnet",
        "horizon",
        "STELLAR_HORIZON_URL"
      )
    ).toThrow(/ENV_NETWORK_MISMATCH/);
  });

  it("rejects a testnet Horizon URL on a mainnet deployment", () => {
    expect(() =>
      assertEndpointMatchesNetwork(
        "https://horizon-testnet.stellar.org",
        "mainnet",
        "horizon",
        "STELLAR_HORIZON_URL"
      )
    ).toThrow(/not a known horizon endpoint/);
  });

  it("does not accept a Horizon host as an RPC endpoint (kind matters)", () => {
    expect(() =>
      assertEndpointMatchesNetwork(
        "https://horizon.stellar.org",
        "mainnet",
        "rpc",
        "STELLAR_RPC_URL"
      )
    ).toThrow(/not a known rpc endpoint/);
  });
});

// #1135 — Soroban RPC URL matches network
describe("assertEndpointMatchesNetwork (rpc)", () => {
  it("accepts both documented mainnet RPC aliases for mainnet", () => {
    for (const url of [
      "https://soroban-mainnet.stellar.org:443",
      "https://soroban.stellar.org",
    ]) {
      expect(() =>
        assertEndpointMatchesNetwork(url, "mainnet", "rpc", "STELLAR_RPC_URL")
      ).not.toThrow();
    }
  });

  it("accepts the testnet RPC URL for testnet", () => {
    expect(() =>
      assertEndpointMatchesNetwork(
        "https://soroban-testnet.stellar.org:443",
        "testnet",
        "rpc",
        "STELLAR_RPC_URL"
      )
    ).not.toThrow();
  });

  it("rejects the mainnet RPC URL when the network is testnet", () => {
    expect(() =>
      assertEndpointMatchesNetwork(
        "https://soroban-mainnet.stellar.org",
        "testnet",
        "rpc",
        "STELLAR_RPC_URL"
      )
    ).toThrow(/ENV_NETWORK_MISMATCH/);
  });

  it("rejects a testnet RPC URL on a mainnet deployment", () => {
    expect(() =>
      assertEndpointMatchesNetwork(
        "https://soroban-testnet.stellar.org",
        "mainnet",
        "rpc",
        "STELLAR_RPC_URL"
      )
    ).toThrow(/STELLAR_RPC_URL/);
  });
});

describe("assertEndpointMatchesNetwork (non-public hosts)", () => {
  it("allows localhost and private nodes (standalone/devnet)", () => {
    for (const url of [
      "http://localhost:8000",
      "http://soroban:8000",
      "http://127.0.0.1:8000",
      "http://rpc.internal:8000",
      "http://[::1]:8000",
    ]) {
      expect(() =>
        assertEndpointMatchesNetwork(url, "testnet", "rpc", "STELLAR_RPC_URL")
      ).not.toThrow();
    }
  });

  it("allows third-party provider hosts (network unverifiable, not wrong)", () => {
    expect(() =>
      assertEndpointMatchesNetwork(
        "https://rpc.example-provider.com",
        "mainnet",
        "rpc",
        "STELLAR_RPC_URL"
      )
    ).not.toThrow();
  });

  it("skips checks entirely for custom networks", () => {
    expect(() =>
      assertEndpointMatchesNetwork(
        "https://horizon.stellar.org",
        "standalone",
        "horizon",
        "STELLAR_HORIZON_URL"
      )
    ).not.toThrow();
  });
});

describe("collectUnverifiableEndpointWarnings", () => {
  it("is silent for first-party endpoints", () => {
    expect(
      collectUnverifiableEndpointWarnings(
        {
          STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
          STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
        },
        "testnet"
      )
    ).toEqual([]);
  });

  it("warns once per unverifiable endpoint", () => {
    const warnings = collectUnverifiableEndpointWarnings(
      {
        STELLAR_RPC_URL:
          "https://rpc.provider-a.com,https://rpc.provider-b.com",
        STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
      },
      "testnet"
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("rpc.provider-a.com");
  });

  it("returns nothing for custom networks", () => {
    expect(
      collectUnverifiableEndpointWarnings(
        { STELLAR_RPC_URL: "https://rpc.provider-a.com" },
        "standalone"
      )
    ).toEqual([]);
  });
});

describe("assertStellarNetworkConsistency", () => {
  it("passes a coherent testnet deployment", () => {
    expect(() =>
      assertStellarNetworkConsistency({
        STELLAR_NETWORK: "testnet",
        SOROBAN_NETWORK_PASSPHRASE: TESTNET,
        STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
        STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      })
    ).not.toThrow();
  });

  it("passes when nothing network-related is set (composes with per-service requirements)", () => {
    expect(() => assertStellarNetworkConsistency({})).not.toThrow();
  });

  it("defaults STELLAR_NETWORK to testnet, catching a mainnet passphrase with no explicit network", () => {
    expect(() =>
      assertStellarNetworkConsistency({
        SOROBAN_NETWORK_PASSPHRASE: MAINNET,
      })
    ).toThrow(/ENV_NETWORK_MISMATCH/);
  });

  it("catches passphrase/network drift before any endpoint check", () => {
    expect(() =>
      assertStellarNetworkConsistency({
        STELLAR_NETWORK: "testnet",
        SOROBAN_NETWORK_PASSPHRASE: MAINNET,
        STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      })
    ).toThrow(/SOROBAN_NETWORK_PASSPHRASE/);
  });

  it("catches a mainnet Horizon URL on a testnet deployment", () => {
    expect(() =>
      assertStellarNetworkConsistency({
        STELLAR_NETWORK: "testnet",
        SOROBAN_NETWORK_PASSPHRASE: TESTNET,
        STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      })
    ).toThrow(/STELLAR_HORIZON_URL/);
  });

  it("catches drift hidden in the comma-separated *_URLS list", () => {
    expect(() =>
      assertStellarNetworkConsistency({
        STELLAR_NETWORK: "testnet",
        STELLAR_RPC_URLS:
          "https://soroban-testnet.stellar.org, https://soroban-mainnet.stellar.org",
      })
    ).toThrow(/STELLAR_RPC_URLS/);
  });

  it("catches drift in a padded / trailing-dot endpoint entry", () => {
    expect(() =>
      assertStellarNetworkConsistency({
        STELLAR_NETWORK: "testnet",
        STELLAR_RPC_URL: "  https://soroban-mainnet.stellar.org.  ",
      })
    ).toThrow(/ENV_NETWORK_MISMATCH/);
  });
});

describe("warnUnverifiableStellarEndpoints", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  afterEach(() => warn.mockClear());

  it("warns in production", () => {
    const warnings = warnUnverifiableStellarEndpoints(
      {
        STELLAR_NETWORK: "testnet",
        STELLAR_RPC_URL: "https://rpc.provider-a.com",
        NODE_ENV: "production",
      },
      "production"
    );
    expect(warnings).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("stays quiet outside production", () => {
    const warnings = warnUnverifiableStellarEndpoints(
      {
        STELLAR_NETWORK: "testnet",
        STELLAR_RPC_URL: "https://rpc.provider-a.com",
        NODE_ENV: "development",
      },
      "development"
    );
    expect(warnings).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});
