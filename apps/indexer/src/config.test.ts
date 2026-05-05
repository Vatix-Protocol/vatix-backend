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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
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
});
