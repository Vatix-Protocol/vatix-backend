import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  signResolutionReport,
  verifyResolutionReport,
} from "./signature-helper.js";
import type { ResolutionPayload } from "./signature-helper.js";

const testKeypair = Keypair.random();
const SECRET = testKeypair.secret();

const basePayload: ResolutionPayload = {
  marketId: "market-001",
  outcome: true,
  timestamp: "2026-01-01T00:00:00.000Z",
};

describe("signResolutionReport", () => {
  it("returns a report with payload, signature, and publicKey", () => {
    const report = signResolutionReport(basePayload, SECRET);

    expect(report.payload).toEqual(basePayload);
    expect(typeof report.signature).toBe("string");
    expect(report.signature.length).toBeGreaterThan(0);
    expect(report.publicKey).toBe(testKeypair.publicKey());
  });

  it("produces the same signature for identical payloads (deterministic)", () => {
    const r1 = signResolutionReport(basePayload, SECRET);
    const r2 = signResolutionReport(basePayload, SECRET);

    expect(r1.signature).toBe(r2.signature);
  });

  it("produces different signatures when marketId differs", () => {
    const r1 = signResolutionReport(basePayload, SECRET);
    const r2 = signResolutionReport(
      { ...basePayload, marketId: "market-002" },
      SECRET
    );

    expect(r1.signature).not.toBe(r2.signature);
  });

  it("produces different signatures when outcome differs", () => {
    const r1 = signResolutionReport({ ...basePayload, outcome: true }, SECRET);
    const r2 = signResolutionReport({ ...basePayload, outcome: false }, SECRET);

    expect(r1.signature).not.toBe(r2.signature);
  });

  it("throws on an invalid secret key", () => {
    expect(() => signResolutionReport(basePayload, "not-a-key")).toThrow();
  });
});

describe("domain separation (#978)", () => {
  const TESTNET = "Test SDF Network ; September 2015";
  const MAINNET = "Public Global Stellar Network ; September 2015";

  it("a report signed for one network does not verify on another", () => {
    const report = signResolutionReport(basePayload, SECRET, TESTNET);

    expect(verifyResolutionReport(report, TESTNET)).toBe(true);
    expect(verifyResolutionReport(report, MAINNET)).toBe(false);
  });

  it("changes the signature when the bound network changes", () => {
    const onTestnet = signResolutionReport(basePayload, SECRET, TESTNET);
    const onMainnet = signResolutionReport(basePayload, SECRET, MAINNET);

    expect(onTestnet.signature).not.toBe(onMainnet.signature);
  });

  it("does not verify against the bare (pre-#978) message layout", () => {
    const report = signResolutionReport(basePayload, SECRET, TESTNET);
    const bare = JSON.stringify({
      marketId: basePayload.marketId,
      outcome: basePayload.outcome,
      timestamp: basePayload.timestamp,
    });
    const keypair = Keypair.fromPublicKey(report.publicKey);

    expect(
      keypair.verify(
        Buffer.from(bare, "utf8"),
        Buffer.from(report.signature, "base64")
      )
    ).toBe(false);
  });
});

describe("verifyResolutionReport", () => {
  it("returns true for a freshly signed report", () => {
    const report = signResolutionReport(basePayload, SECRET);

    expect(verifyResolutionReport(report)).toBe(true);
  });

  it("returns false when the signature is tampered", () => {
    const report = signResolutionReport(basePayload, SECRET);
    const tampered = { ...report, signature: "dGFtcGVyZWQ=" };

    expect(verifyResolutionReport(tampered)).toBe(false);
  });

  it("returns false when the payload marketId is changed after signing", () => {
    const report = signResolutionReport(basePayload, SECRET);
    const tampered = {
      ...report,
      payload: { ...report.payload, marketId: "market-evil" },
    };

    expect(verifyResolutionReport(tampered)).toBe(false);
  });

  it("returns false when the payload outcome is changed after signing", () => {
    const report = signResolutionReport(basePayload, SECRET);
    const tampered = {
      ...report,
      payload: { ...report.payload, outcome: false },
    };

    expect(verifyResolutionReport(tampered)).toBe(false);
  });

  it("returns false for a malformed signature string", () => {
    const report = signResolutionReport(basePayload, SECRET);
    const tampered = { ...report, signature: "!!!not-base64!!!" };

    expect(verifyResolutionReport(tampered)).toBe(false);
  });

  it("returns false when the publicKey does not match the signing key", () => {
    const other = Keypair.random();
    const report = signResolutionReport(basePayload, SECRET);
    const tampered = { ...report, publicKey: other.publicKey() };

    expect(verifyResolutionReport(tampered)).toBe(false);
  });
});
