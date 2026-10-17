import { describe, it, expect, vi, afterEach } from "vitest";
import { loadIndexerConfig, KNOWN_PASSPHRASES } from "./config.js";
import { validateEnv, EnvValidationError } from "./env.js";

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
      SOROBAN_NETWORK_PASSPHRASE: "Custom Network ; 2024",
      INDEXER_CONTRACT_ID: CONTRACT_ID,
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
      loadIndexerConfig({ SOROBAN_NETWORK_PASSPHRASE: MAINNET })
    ).toThrow(/ENV_UNSAFE_MAINNET/);
  });

  it("allows mainnet when explicitly opted in", () => {
    const cfg = loadIndexerConfig({
      SOROBAN_NETWORK_PASSPHRASE: MAINNET,
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

// ── HTTP flag validation (#1293) ──────────────────────────────────────────
//
// The HTTP flags control whether the server starts at all, so they must be
// part of the fail-closed boot contract. Invalid values must surface as an
// EnvValidationError naming the variable and a stable code, without echoing
// the offending raw value into the error output.
describe("HTTP flag validation (#1293)", () => {
  const base = {
    SOROBAN_NETWORK_PASSPHRASE: TESTNET,
    INDEXER_CONTRACT_ID: CONTRACT_ID,
  };

  function catchEnv(env: Record<string, string>): unknown {
    try {
      validateEnv(env);
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it("accepts a valid baseline with HTTP flags set", () => {
    const result = validateEnv({
      ...base,
      INDEXER_HTTP_ENABLED: "true",
      INDEXER_HTTP_FORCE_LIVE_CHECK: "false",
      INDEXER_HTTP_PORT: "8080",
    });
    expect(result.INDEXER_HTTP_ENABLED).toBe("true");
    expect(result.INDEXER_HTTP_FORCE_LIVE_CHECK).toBe("false");
    expect(result.INDEXER_HTTP_PORT).toBe("8080");
  });

  it("rejects INDEXER_HTTP_ENABLED=yes", () => {
    const caught = catchEnv({ ...base, INDEXER_HTTP_ENABLED: "yes" });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.issues.some((i) => i.name === "INDEXER_HTTP_ENABLED")).toBe(
      true
    );
    expect(String(err)).toContain("INDEXER_HTTP_ENABLED");
    expect(String(err)).not.toContain("yes");
  });

  it("rejects INDEXER_HTTP_FORCE_LIVE_CHECK=1", () => {
    const caught = catchEnv({ ...base, INDEXER_HTTP_FORCE_LIVE_CHECK: "1" });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(
      err.issues.some((i) => i.name === "INDEXER_HTTP_FORCE_LIVE_CHECK")
    ).toBe(true);
    expect(String(err)).toContain("INDEXER_HTTP_FORCE_LIVE_CHECK");
    expect(String(err)).not.toContain("1");
  });

  it("rejects INDEXER_HTTP_PORT=abc", () => {
    const caught = catchEnv({ ...base, INDEXER_HTTP_PORT: "abc" });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.issues.some((i) => i.name === "INDEXER_HTTP_PORT")).toBe(true);
    expect(String(err)).toContain("INDEXER_HTTP_PORT");
    expect(String(err)).not.toContain("abc");
  });

  it("rejects INDEXER_HTTP_PORT=0", () => {
    const caught = catchEnv({ ...base, INDEXER_HTTP_PORT: "0" });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.issues.some((i) => i.name === "INDEXER_HTTP_PORT")).toBe(true);
  });

  it("rejects INDEXER_HTTP_PORT=70000", () => {
    const caught = catchEnv({ ...base, INDEXER_HTTP_PORT: "70000" });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.issues.some((i) => i.name === "INDEXER_HTTP_PORT")).toBe(true);
  });
});
