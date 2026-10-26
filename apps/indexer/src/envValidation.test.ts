import { describe, it, expect, vi, afterEach } from "vitest";
import {
  validateEnv,
  EnvValidationError,
  ENV_ERROR_CODES,
  KNOWN_PASSPHRASES,
} from "./config.js";

const TESTNET = KNOWN_PASSPHRASES.testnet;
const MAINNET = KNOWN_PASSPHRASES.mainnet;

const CONTRACT_ID = "CTESTCONTRACT";

const BASE = {
  INDEXER_CONTRACT_ID: CONTRACT_ID,
};

afterEach(() => vi.restoreAllMocks());

function catchEnv(env: Record<string, string>): unknown {
  try {
    validateEnv(env);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("validateEnv passphrase: missing vs blank", () => {
  it("throws ENV_MISSING when SOROBAN_NETWORK_PASSPHRASE is absent", () => {
    const caught = catchEnv({ ...BASE });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.code).toBe(ENV_ERROR_CODES.ENV_MISSING);
    expect(err.variable).toBe("SOROBAN_NETWORK_PASSPHRASE");
    expect(err.message.startsWith(ENV_ERROR_CODES.ENV_MISSING)).toBe(true);
  });

  it("throws ENV_INVALID when SOROBAN_NETWORK_PASSPHRASE is empty string", () => {
    const caught = catchEnv({ ...BASE, SOROBAN_NETWORK_PASSPHRASE: "" });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.code).toBe(ENV_ERROR_CODES.ENV_INVALID);
    expect(err.variable).toBe("SOROBAN_NETWORK_PASSPHRASE");
    expect(err.message.startsWith(ENV_ERROR_CODES.ENV_INVALID)).toBe(true);
  });

  it("throws ENV_INVALID when SOROBAN_NETWORK_PASSPHRASE is whitespace", () => {
    const caught = catchEnv({ ...BASE, SOROBAN_NETWORK_PASSPHRASE: "   " });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.code).toBe(ENV_ERROR_CODES.ENV_INVALID);
    expect(err.variable).toBe("SOROBAN_NETWORK_PASSPHRASE");
    expect(err.message.startsWith(ENV_ERROR_CODES.ENV_INVALID)).toBe(true);
  });
});

describe("validateEnv mainnet opt-in gate", () => {
  it("throws ENV_UNSAFE_MAINNET for mainnet without opt-in", () => {
    const caught = catchEnv({
      ...BASE,
      SOROBAN_NETWORK_PASSPHRASE: MAINNET,
    });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.code).toBe(ENV_ERROR_CODES.ENV_UNSAFE_MAINNET);
    expect(err.variable).toBe("VATIX_ALLOW_MAINNET");
    expect(err.message.startsWith(ENV_ERROR_CODES.ENV_UNSAFE_MAINNET)).toBe(
      true
    );
  });

  it("accepts mainnet with VATIX_ALLOW_MAINNET='true'", () => {
    expect(() =>
      validateEnv({
        ...BASE,
        SOROBAN_NETWORK_PASSPHRASE: MAINNET,
        VATIX_ALLOW_MAINNET: "true",
      })
    ).not.toThrow();
  });

  it("accepts mainnet with VATIX_ALLOW_MAINNET='1'", () => {
    expect(() =>
      validateEnv({
        ...BASE,
        SOROBAN_NETWORK_PASSPHRASE: MAINNET,
        VATIX_ALLOW_MAINNET: "1",
      })
    ).not.toThrow();
  });

  it("rejects mainnet with VATIX_ALLOW_MAINNET='yes'", () => {
    const caught = catchEnv({
      ...BASE,
      SOROBAN_NETWORK_PASSPHRASE: MAINNET,
      VATIX_ALLOW_MAINNET: "yes",
    });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.code).toBe(ENV_ERROR_CODES.ENV_UNSAFE_MAINNET);
    expect(err.variable).toBe("VATIX_ALLOW_MAINNET");
    expect(err.message.startsWith(ENV_ERROR_CODES.ENV_UNSAFE_MAINNET)).toBe(
      true
    );
  });

  it("rejects mainnet with VATIX_ALLOW_MAINNET='TRUE'", () => {
    const caught = catchEnv({
      ...BASE,
      SOROBAN_NETWORK_PASSPHRASE: MAINNET,
      VATIX_ALLOW_MAINNET: "TRUE",
    });
    expect(caught).toBeInstanceOf(EnvValidationError);
    const err = caught as EnvValidationError;
    expect(err.code).toBe(ENV_ERROR_CODES.ENV_UNSAFE_MAINNET);
    expect(err.variable).toBe("VATIX_ALLOW_MAINNET");
    expect(err.message.startsWith(ENV_ERROR_CODES.ENV_UNSAFE_MAINNET)).toBe(
      true
    );
  });
});

describe("validateEnv unknown passphrase", () => {
  it("warns but does not throw for an unknown passphrase", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      validateEnv({
        ...BASE,
        SOROBAN_NETWORK_PASSPHRASE: "Custom Network ; 2024",
      })
    ).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Unknown Soroban network passphrase")
    );
  });

  it("does not warn for the known testnet passphrase", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateEnv({ ...BASE, SOROBAN_NETWORK_PASSPHRASE: TESTNET });
    expect(warn).not.toHaveBeenCalled();
  });
});
