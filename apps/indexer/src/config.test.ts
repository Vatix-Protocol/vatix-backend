import { describe, it, expect, vi, afterEach } from "vitest";
import { loadIndexerConfig, KNOWN_PASSPHRASES } from "./config.js";

const TESTNET = KNOWN_PASSPHRASES.testnet;
const MAINNET = KNOWN_PASSPHRASES.mainnet;

afterEach(() => vi.restoreAllMocks());

describe("loadIndexerConfig", () => {
  it("accepts the testnet passphrase without warning", () => {
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const cfg = loadIndexerConfig({ SOROBAN_NETWORK_PASSPHRASE: TESTNET });
    expect(cfg.sorobanNetworkPassphrase).toBe(TESTNET);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts the mainnet passphrase without warning", () => {
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const cfg = loadIndexerConfig({ SOROBAN_NETWORK_PASSPHRASE: MAINNET });
    expect(cfg.sorobanNetworkPassphrase).toBe(MAINNET);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns on an unknown passphrase but still returns config", () => {
    const warn = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const cfg = loadIndexerConfig({
      SOROBAN_NETWORK_PASSPHRASE: "Custom Network ; 2024",
    });
    expect(cfg.sorobanNetworkPassphrase).toBe("Custom Network ; 2024");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Unknown Soroban network passphrase")
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
      STELLAR_HORIZON_URL: "https://horizon.stellar.org",
    });
    expect(cfg.horizonUrl).toBe("https://horizon.stellar.org");
  });

  it("falls back to testnet horizon URL when STELLAR_HORIZON_URL is absent", () => {
    const cfg = loadIndexerConfig({ SOROBAN_NETWORK_PASSPHRASE: TESTNET });
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
      loadIndexerConfig({ SOROBAN_NETWORK_PASSPHRASE: MAINNET })
    ).toThrow(/ENV_UNSAFE_MAINNET/);
  });

  it("allows mainnet when explicitly opted in", () => {
    const cfg = loadIndexerConfig({
      SOROBAN_NETWORK_PASSPHRASE: MAINNET,
      VATIX_ALLOW_MAINNET: "true",
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
