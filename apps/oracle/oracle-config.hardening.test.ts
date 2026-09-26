/**
 * Oracle config — fail-closed validation of key material, bounds and drift
 * detection (#1115).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  loadOracleConfig,
  describeOracleConfig,
  OracleConfigError,
  ORACLE_CONFIG_ERROR_CODES,
  MAX_CHALLENGE_WINDOW_SECONDS,
  MAX_PROVIDER_TIMEOUT_MS,
} from "./oracle-config.js";

const keypair = Keypair.random();
const otherKeypair = Keypair.random();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function expectConfigError(fn: () => unknown, code: string, variable: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(OracleConfigError);
    expect((error as OracleConfigError).code).toBe(code);
    expect((error as OracleConfigError).variable).toBe(variable);
    expect((error as OracleConfigError).correlationId).toMatch(/^ocfg_/);
    return;
  }
  throw new Error("expected loadOracleConfig to throw");
}

describe("signing key validation (#1115)", () => {
  it("rejects a placeholder or malformed secret key", () => {
    expectConfigError(
      () => loadOracleConfig({ ORACLE_SECRET_KEY: "secret123" }),
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      "ORACLE_SECRET_KEY"
    );
  });

  it("rejects a truncated secret key", () => {
    expectConfigError(
      () =>
        loadOracleConfig({ ORACLE_SECRET_KEY: keypair.secret().slice(0, 20) }),
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      "ORACLE_SECRET_KEY"
    );
  });

  it("derives the signer public key from the secret", () => {
    const config = loadOracleConfig({ ORACLE_SECRET_KEY: keypair.secret() });
    expect(config.signerPublicKey).toBe(keypair.publicKey());
  });

  it("tolerates surrounding whitespace in the secret", () => {
    const config = loadOracleConfig({
      ORACLE_SECRET_KEY: `  ${keypair.secret()}  `,
    });
    expect(config.signerPublicKey).toBe(keypair.publicKey());
  });

  it("accepts a matching pinned signer", () => {
    const config = loadOracleConfig({
      ORACLE_SECRET_KEY: keypair.secret(),
      ORACLE_SIGNER_PUBLIC_KEY: keypair.publicKey(),
    });
    expect(config.trustedSignerPublicKey).toBe(keypair.publicKey());
  });

  it("rejects a malformed pinned signer", () => {
    expectConfigError(
      () => loadOracleConfig({ ORACLE_SIGNER_PUBLIC_KEY: "not-a-key" }),
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      "ORACLE_SIGNER_PUBLIC_KEY"
    );
  });

  it("fails closed on signer drift (wrong network's keypair loaded)", () => {
    expectConfigError(
      () =>
        loadOracleConfig({
          ORACLE_SECRET_KEY: keypair.secret(),
          ORACLE_SIGNER_PUBLIC_KEY: otherKeypair.publicKey(),
        }),
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_SIGNER_MISMATCH,
      "ORACLE_SIGNER_PUBLIC_KEY"
    );
  });

  it("never embeds key material in the error message", () => {
    try {
      loadOracleConfig({
        ORACLE_SECRET_KEY: keypair.secret(),
        ORACLE_SIGNER_PUBLIC_KEY: otherKeypair.publicKey(),
      });
    } catch (error) {
      expect((error as Error).message).not.toContain(keypair.secret());
    }
  });
});

describe("numeric bounds (#1115)", () => {
  it("rejects a challenge window beyond the upper bound (unit mix-up)", () => {
    expectConfigError(
      () =>
        loadOracleConfig({
          ORACLE_CHALLENGE_WINDOW_SECONDS: String(
            MAX_CHALLENGE_WINDOW_SECONDS + 1
          ),
        }),
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      "ORACLE_CHALLENGE_WINDOW_SECONDS"
    );
  });

  it("rejects a provider timeout beyond the upper bound", () => {
    expectConfigError(
      () =>
        loadOracleConfig({
          ORACLE_PRIMARY_TIMEOUT_MS: String(MAX_PROVIDER_TIMEOUT_MS + 1),
        }),
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      "ORACLE_PRIMARY_TIMEOUT_MS"
    );

    expectConfigError(
      () =>
        loadOracleConfig({
          ORACLE_FALLBACK_TIMEOUT_MS: String(MAX_PROVIDER_TIMEOUT_MS + 1),
        }),
      ORACLE_CONFIG_ERROR_CODES.ORACLE_CONFIG_INVALID_VALUE,
      "ORACLE_FALLBACK_TIMEOUT_MS"
    );
  });

  it("keeps accepting in-range values", () => {
    const config = loadOracleConfig({
      ORACLE_CHALLENGE_WINDOW_SECONDS: "3600",
      ORACLE_PRIMARY_TIMEOUT_MS: "1500",
      ORACLE_FALLBACK_TIMEOUT_MS: "2000",
    });
    expect(config.challengeWindowSeconds).toBe(3600);
    expect(config.primaryTimeoutMs).toBe(1500);
    expect(config.fallbackTimeoutMs).toBe(2000);
  });
});

describe("describeOracleConfig (#1115)", () => {
  it("redacts the secret key", () => {
    const config = loadOracleConfig({ ORACLE_SECRET_KEY: keypair.secret() });
    const summary = describeOracleConfig(config);

    expect(summary.secretKeyConfigured).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(keypair.secret());
    expect(summary.signerPublicKey).toBe(keypair.publicKey());
  });

  it("reports a missing key without throwing", () => {
    const summary = describeOracleConfig(loadOracleConfig({}));
    expect(summary.secretKeyConfigured).toBe(false);
    expect(summary.signerPublicKey).toBeUndefined();
  });
});
