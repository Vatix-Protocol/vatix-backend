import { describe, it, expect, vi, afterEach } from "vitest";
import { loadIndexerConfig, KNOWN_PASSPHRASES } from "./config.js";

const TESTNET = KNOWN_PASSPHRASES.testnet;
const MAINNET = KNOWN_PASSPHRASES.mainnet;

/**
 * Any contract ID shape is accepted outside production; only the presence of
 * one is required at boot (#1132). See the "contract ID boot gate" suite below
 * for the production strkey rule.
 */
const CONTRACT_ID = "CTESTCONTRACT";

afterEach(() => vi.restoreAllMocks());

describe("loadIndexerConfig", () => {
  it("accepts the testnet passphrase without warning", () => {
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const cfg = loadIndexerConfig({
      SOROBAN_NETWORK_PASSPHRASE: TESTNET,
      INDEXER_CONTRACT_ID: CONTRACT_ID,
    });
    expect(cfg.sorobanNetworkPassphrase).toBe(TESTNET);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts the mainnet passphrase without warning", () => {
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const cfg = loadIndexerConfig({
      SOROBAN_NETWORK_PASSPHRASE: MAINNET,
      STELLAR_NETWORK: "mainnet",
      // Mainnet requires the explicit opt-in (see the ENV_UNSAFE_MAINNET test).
      VATIX_ALLOW_MAINNET: "true",
      INDEXER_CONTRACT_ID: CONTRACT_ID,
    });
    expect(cfg.sorobanNetworkPassphrase).toBe(MAINNET);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on an unknown passphrase but still returns config", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = loadIndexerConfig({
      // A custom/standalone network: STELLAR_NETWORK names it too, so the
      // consistency gate has no published passphrase to compare against (#1133).
      SOROBAN_NETWORK_PASSPHRASE: "Custom Network ; 2024",
      STELLAR_NETWORK: "standalone",
      INDEXER_CONTRACT_ID: CONTRACT_ID,
    });
    expect(cfg.sorobanNetworkPassphrase).toBe("Custom Network ; 2024");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "SOROBAN_NETWORK_PASSPHRASE does not match any known Stellar network"
      )
    );
    // The passphrase value itself must never reach the logs.
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Custom Network ; 2024")
    );
  });

  it("throws when SOROBAN_NETWORK_PASSPHRASE is missing", () => {
    expect(() => loadIndexerConfig({})).toThrow("SOROBAN_NETWORK_PASSPHRASE");
  });

  it("throws when SOROBAN_NETWORK_PASSPHRASE is empty string", () => {
    expect(() =>
      loadIndexerConfig({ SOROBAN_NETWORK_PASSPHRASE: "  " })
    ).toThrow("SOROBAN_NETWORK_PASSPHRASE");
  });

  it("uses STELLAR_HORIZON_URL when provided", () => {
    const cfg = loadIndexerConfig({
      SOROBAN_NETWORK_PASSPHRASE: MAINNET,
      STELLAR_NETWORK: "mainnet",
      VATIX_ALLOW_MAINNET: "true",
      STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      INDEXER_CONTRACT_ID: CONTRACT_ID,
    });
    expect(cfg.horizonUrl).toBe("https://horizon.stellar.org");
  });

  it("falls back to testnet horizon URL when STELLAR_HORIZON_URL is absent", () => {
    const cfg = loadIndexerConfig({
      SOROBAN_NETWORK_PASSPHRASE: TESTNET,
      INDEXER_CONTRACT_ID: CONTRACT_ID,
    });
    expect(cfg.horizonUrl).toBe("https://horizon-testnet.stellar.org");
  });

  it("fails closed with ENV_MISSING when a required var is absent", () => {
    expect(() => loadIndexerConfig({})).toThrow(/ENV_MISSING/);
  });

  it("fails closed with ENV_INVALID when a required var is blank", () => {
    expect(() =>
      loadIndexerConfig({ SOROBAN_NETWORK_PASSPHRASE: "  " })
    ).toThrow(/ENV_INVALID/);
  });

  it("requires explicit opt-in for mainnet-affecting config", () => {
    expect(() =>
      loadIndexerConfig({
        SOROBAN_NETWORK_PASSPHRASE: MAINNET,
        STELLAR_NETWORK: "mainnet",
      })
    ).toThrow(/ENV_UNSAFE_MAINNET/);
  });

  it("allows mainnet when explicitly opted in", () => {
    const cfg = loadIndexerConfig({
      SOROBAN_NETWORK_PASSPHRASE: MAINNET,
      STELLAR_NETWORK: "mainnet",
      VATIX_ALLOW_MAINNET: "true",
      INDEXER_CONTRACT_ID: CONTRACT_ID,
    });
    expect(cfg.sorobanNetworkPassphrase).toBe(MAINNET);
  });

  it("does not leak secret values in error messages", () => {
    const secret = "super-secret-value";
    try {
      loadIndexerConfig({
        SOROBAN_NETWORK_PASSPHRASE: TESTNET,
        VATIX_INDEXER_SECRET: secret,
        VATIX_ALLOW_MAINNET: "not-a-bool",
      });
    } catch (err) {
      expect(String(err)).not.toContain(secret);
    }
  });
});

// ── Contract ID boot gate (#1132) ─────────────────────────────────────────
//
// A missing contract ID must fail the boot gate (not just the later config
// loader) so the process never starts an ingestion loop that can only ever
// ingest nothing. Production additionally requires a well-formed strkey, so a
// drifted/truncated ID cannot silently point at the wrong contract.
describe("contract ID boot gate (#1132)", () => {
  const VALID_STRKEY = `C${"A".repeat(55)}`;

  it("fails closed with ENV_MISSING when no contract ID is configured", () => {
    let caught: unknown;
    try {
      loadIndexerConfig({ SOROBAN_NETWORK_PASSPHRASE: TESTNET });
    } catch (err) {
      caught = err;
    }
    expect(String(caught)).toContain("INDEXER_CONTRACT_ID");
    expect((caught as { code?: string }).code).toBe("ENV_MISSING");
  });

  it("accepts MARKET_CONTRACT_ID as the legacy alias", () => {
    const cfg = loadIndexerConfig({
      SOROBAN_NETWORK_PASSPHRASE: TESTNET,
      MARKET_CONTRACT_ID: CONTRACT_ID,
    });
    expect(cfg.sorobanNetworkPassphrase).toBe(TESTNET);
  });

  it("fails closed with ENV_INVALID on a malformed strkey in production", () => {
    let caught: unknown;
    try {
      loadIndexerConfig({
        NODE_ENV: "production",
        SOROBAN_NETWORK_PASSPHRASE: TESTNET,
        INDEXER_CONTRACT_ID: "not-a-strkey",
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("ENV_INVALID");
    // The rejected value must never be echoed into the error (log safety).
    expect(String(caught)).not.toContain("not-a-strkey");
  });

  it("accepts a valid strkey in production", () => {
    const cfg = loadIndexerConfig({
      NODE_ENV: "production",
      SOROBAN_NETWORK_PASSPHRASE: TESTNET,
      INDEXER_CONTRACT_ID: VALID_STRKEY,
    });
    expect(cfg.sorobanNetworkPassphrase).toBe(TESTNET);
  });

  it("warns (but still resolves) when both aliases are set and disagree", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    loadIndexerConfig({
      SOROBAN_NETWORK_PASSPHRASE: TESTNET,
      INDEXER_CONTRACT_ID: CONTRACT_ID,
      MARKET_CONTRACT_ID: "CLEGACY",
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disagree"));
  });
});
