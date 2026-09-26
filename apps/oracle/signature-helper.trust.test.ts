/**
 * Oracle signature helper — trusted-signer pinning and payload validation
 * (#1113).
 *
 * A resolution report carries its own `publicKey`, so a bare signature check
 * only proves "some key signed this". These tests pin that hole: an
 * attacker-generated report must never verify, and an unpinned deployment must
 * fail closed in production.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  signResolutionReport,
  verifyResolutionReport,
  assertValidResolutionPayload,
  resolveTrustedSignerPublicKey,
  isStellarPublicKey,
  isStellarSecretKey,
  OracleSignatureError,
  ORACLE_SIGNATURE_ERROR_CODES,
  MAX_MARKET_ID_LENGTH,
  type ResolutionPayload,
} from "./signature-helper.js";

const oracleKeypair = Keypair.random();
const attackerKeypair = Keypair.random();
const ORACLE_PUBLIC_KEY = oracleKeypair.publicKey();

const payload: ResolutionPayload = {
  marketId: "market-001",
  outcome: true,
  timestamp: "2026-01-01T00:00:00.000Z",
};

const PRODUCTION_ENV = { NODE_ENV: "production" };
const TEST_ENV = { NODE_ENV: "test" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("payload validation (#1113)", () => {
  it("accepts a well-formed payload", () => {
    expect(() => assertValidResolutionPayload(payload)).not.toThrow();
  });

  it("rejects an empty market id", () => {
    expect(() =>
      assertValidResolutionPayload({ ...payload, marketId: "" })
    ).toThrow(OracleSignatureError);
  });

  it("rejects an over-long market id (adversarial input)", () => {
    expect(() =>
      assertValidResolutionPayload({
        ...payload,
        marketId: "m".repeat(MAX_MARKET_ID_LENGTH + 1),
      })
    ).toThrow(/marketId/);
  });

  it("rejects a non-boolean outcome", () => {
    expect(() =>
      assertValidResolutionPayload({
        ...payload,
        outcome: "yes" as unknown as boolean,
      })
    ).toThrow(/boolean/);
  });

  it("rejects an unparseable timestamp", () => {
    expect(() =>
      assertValidResolutionPayload({ ...payload, timestamp: "not-a-date" })
    ).toThrow(/ISO-8601/);
  });

  it("refuses to sign an invalid payload", () => {
    expect(() =>
      signResolutionReport({ ...payload, marketId: "" }, oracleKeypair.secret())
    ).toThrow(OracleSignatureError);
  });
});

describe("strkey helpers", () => {
  it("recognises Stellar account ids and secret keys", () => {
    expect(isStellarPublicKey(ORACLE_PUBLIC_KEY)).toBe(true);
    expect(isStellarSecretKey(oracleKeypair.secret())).toBe(true);
  });

  it("rejects placeholders and wrong prefixes", () => {
    expect(isStellarPublicKey("GORACLE1")).toBe(false);
    expect(isStellarSecretKey("secret123")).toBe(false);
    expect(isStellarPublicKey(oracleKeypair.secret())).toBe(false);
  });
});

describe("trusted signer resolution (#1113)", () => {
  it("returns undefined when unset", () => {
    expect(resolveTrustedSignerPublicKey({})).toBeUndefined();
    expect(
      resolveTrustedSignerPublicKey({ ORACLE_SIGNER_PUBLIC_KEY: " " })
    ).toBeUndefined();
  });

  it("returns a valid pinned signer", () => {
    expect(
      resolveTrustedSignerPublicKey({
        ORACLE_SIGNER_PUBLIC_KEY: ORACLE_PUBLIC_KEY,
      })
    ).toBe(ORACLE_PUBLIC_KEY);
  });

  it("throws on a malformed pinned signer (typo must not disable pinning)", () => {
    expect(() =>
      resolveTrustedSignerPublicKey({ ORACLE_SIGNER_PUBLIC_KEY: "not-a-key" })
    ).toThrow(OracleSignatureError);

    try {
      resolveTrustedSignerPublicKey({ ORACLE_SIGNER_PUBLIC_KEY: "nope" });
    } catch (error) {
      expect((error as OracleSignatureError).code).toBe(
        ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_INVALID_TRUSTED_SIGNER
      );
    }
  });
});

describe("verifyResolutionReport signer pinning (#1113)", () => {
  it("accepts a report from the pinned signer", () => {
    const report = signResolutionReport(payload, oracleKeypair.secret());
    expect(
      verifyResolutionReport(report, undefined, {
        env: PRODUCTION_ENV,
        expectedPublicKey: ORACLE_PUBLIC_KEY,
      })
    ).toBe(true);
  });

  it("rejects a self-signed report from an attacker key", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const forged = signResolutionReport(payload, attackerKeypair.secret());

    expect(
      verifyResolutionReport(forged, undefined, {
        env: PRODUCTION_ENV,
        expectedPublicKey: ORACLE_PUBLIC_KEY,
      })
    ).toBe(false);
  });

  it("rejects an attacker report outside production too when a signer is pinned", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const forged = signResolutionReport(payload, attackerKeypair.secret());

    expect(
      verifyResolutionReport(forged, undefined, {
        env: TEST_ENV,
        expectedPublicKey: ORACLE_PUBLIC_KEY,
      })
    ).toBe(false);
  });

  it("pins the signer from ORACLE_SIGNER_PUBLIC_KEY", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const forged = signResolutionReport(payload, attackerKeypair.secret());

    expect(
      verifyResolutionReport(forged, undefined, {
        env: {
          NODE_ENV: "production",
          ORACLE_SIGNER_PUBLIC_KEY: ORACLE_PUBLIC_KEY,
        },
      })
    ).toBe(false);
  });

  it("fails closed in production when no signer is pinned", () => {
    const report = signResolutionReport(payload, oracleKeypair.secret());

    expect(() =>
      verifyResolutionReport(report, undefined, { env: PRODUCTION_ENV })
    ).toThrow(OracleSignatureError);

    try {
      verifyResolutionReport(report, undefined, { env: PRODUCTION_ENV });
    } catch (error) {
      expect((error as OracleSignatureError).code).toBe(
        ORACLE_SIGNATURE_ERROR_CODES.ORACLE_SIGNATURE_TRUSTED_SIGNER_REQUIRED
      );
    }
  });

  it("honours an explicit requireTrustedSigner outside production", () => {
    const report = signResolutionReport(payload, oracleKeypair.secret());

    expect(() =>
      verifyResolutionReport(report, undefined, {
        env: TEST_ENV,
        requireTrustedSigner: true,
      })
    ).toThrow(OracleSignatureError);
  });

  it("still verifies outside production when no signer is pinned (dev flow)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const report = signResolutionReport(payload, oracleKeypair.secret());

    expect(verifyResolutionReport(report, undefined, { env: TEST_ENV })).toBe(
      true
    );
  });

  it("returns false for a structurally invalid report instead of throwing", () => {
    expect(
      verifyResolutionReport(
        null as unknown as ResolutionPayload & { signature: string },
        undefined,
        { env: TEST_ENV }
      )
    ).toBe(false);
  });

  it("does not leak key material in the failure message", () => {
    const report = signResolutionReport(payload, oracleKeypair.secret());
    let message = "";
    try {
      verifyResolutionReport(report, undefined, { env: PRODUCTION_ENV });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain(oracleKeypair.secret());
  });
});
