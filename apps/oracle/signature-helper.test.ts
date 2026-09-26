import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  signResolutionReport,
  verifyResolutionReport,
  buildResolutionMessage,
  LegacySignatureRejectedError,
  CURRENT_SIGNATURE_VERSION,
} from "./signature-helper.js";
import type {
  ResolutionPayload,
  SignedResolutionReport,
} from "./signature-helper.js";

/** Builds a pre-#978 legacy report: domain-separated only, no network passphrase. */
function signLegacyReport(
  payload: ResolutionPayload,
  keypair: Keypair
): SignedResolutionReport {
  const legacyMessage = Buffer.from(
    JSON.stringify({
      domain: "vatix.oracle-resolution.v1",
      payload: {
        marketId: payload.marketId,
        outcome: payload.outcome,
        timestamp: payload.timestamp,
      },
    }),
    "utf8"
  );
  return {
    payload,
    signature: keypair.sign(legacyMessage).toString("base64"),
    publicKey: keypair.publicKey(),
  };
}

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

describe("signature envelope versioning (#993)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stamps newly signed reports with the current version", () => {
    const report = signResolutionReport(basePayload, SECRET);
    expect(report.version).toBe(CURRENT_SIGNATURE_VERSION);
    expect(CURRENT_SIGNATURE_VERSION).toBe(2);
  });

  it("rejects a legacy (passphrase-less) signature in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "SOROBAN_NETWORK_PASSPHRASE",
      "Public Global Stellar Network ; September 2015"
    );
    const legacy = signLegacyReport(basePayload, testKeypair);

    expect(() => verifyResolutionReport(legacy)).toThrow(
      LegacySignatureRejectedError
    );
  });

  it("still verifies a legacy signature outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    const legacy = signLegacyReport(basePayload, testKeypair);

    expect(verifyResolutionReport(legacy)).toBe(true);
  });

  it("rejects a current (v2) signature verified as if it were legacy-tampered to v1", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "SOROBAN_NETWORK_PASSPHRASE",
      "Public Global Stellar Network ; September 2015"
    );
    const report = signResolutionReport(
      basePayload,
      SECRET,
      "Public Global Stellar Network ; September 2015"
    );
    const downgraded: SignedResolutionReport = { ...report, version: 1 };

    expect(() => verifyResolutionReport(downgraded)).toThrow(
      LegacySignatureRejectedError
    );
  });
});

/**
 * Frozen known-answer vectors (#1148).
 *
 * These vectors pin the *bytes* and the *signature* for a fixed, test-only
 * keypair. They exist so any re-implementation (another service, a contract
 * test harness, the web client) can be checked byte-for-byte against this
 * repository, and so an accidental change to payload key order, domain tag, or
 * network binding fails loudly here instead of silently invalidating every
 * signature already in flight.
 *
 * The keypair seed below is a public constant and must never be used outside
 * tests — it is derived from 32 bytes of `0x07`, not from any deployment key.
 */
describe("known-answer vectors (#1148)", () => {
  const TESTNET = "Test SDF Network ; September 2015";
  const MAINNET = "Public Global Stellar Network ; September 2015";

  /** Deterministic, test-only keypair (seed = 32 × 0x07). */
  const vectorKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
  const VECTOR_SECRET = vectorKeypair.secret();
  const VECTOR_PUBLIC_KEY =
    "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";

  const vectorPayload: ResolutionPayload = {
    marketId: "market-vector-001",
    outcome: false,
    timestamp: "2026-06-29T00:00:00.000Z",
  };

  const TESTNET_MESSAGE =
    '{"domain":"vatix.oracle-resolution.v1","network":"Test SDF Network ; September 2015","payload":{"marketId":"market-vector-001","outcome":false,"timestamp":"2026-06-29T00:00:00.000Z"}}';
  const MAINNET_MESSAGE =
    '{"domain":"vatix.oracle-resolution.v1","network":"Public Global Stellar Network ; September 2015","payload":{"marketId":"market-vector-001","outcome":false,"timestamp":"2026-06-29T00:00:00.000Z"}}';

  const TESTNET_SIGNATURE =
    "LQ7YleBIxfi0H6I86dd9I2X5ArPVU6vOmfmGiUDe7jGkJMUfUPCTxzmX6KYtdjeZQNvw5jPnKOw8LohjFQIsDA==";
  const MAINNET_SIGNATURE =
    "r393T0RBHVFrvTOrBZKe5CVhNAi03WE+f4x6roXnv6+GZqQWB0IUOeGCIIRokoF6toOblcs8/AJUsKZrUXrHDg==";

  it("derives the documented public key from the vector seed", () => {
    expect(vectorKeypair.publicKey()).toBe(VECTOR_PUBLIC_KEY);
  });

  it("builds the frozen canonical message for testnet and mainnet", () => {
    expect(buildResolutionMessage(vectorPayload, TESTNET)).toBe(
      TESTNET_MESSAGE
    );
    expect(buildResolutionMessage(vectorPayload, MAINNET)).toBe(
      MAINNET_MESSAGE
    );
  });

  it("produces the frozen testnet signature", () => {
    const report = signResolutionReport(vectorPayload, VECTOR_SECRET, TESTNET);

    expect(report.publicKey).toBe(VECTOR_PUBLIC_KEY);
    expect(report.signature).toBe(TESTNET_SIGNATURE);
    expect(report.version).toBe(CURRENT_SIGNATURE_VERSION);
  });

  it("produces the frozen mainnet signature and keeps networks non-interchangeable", () => {
    const onMainnet = signResolutionReport(
      vectorPayload,
      VECTOR_SECRET,
      MAINNET
    );

    expect(onMainnet.signature).toBe(MAINNET_SIGNATURE);
    expect(verifyResolutionReport(onMainnet, MAINNET)).toBe(true);
    expect(verifyResolutionReport(onMainnet, TESTNET)).toBe(false);
  });

  it("verifies an externally produced signature over the frozen message", () => {
    // A third-party signer only needs buildResolutionMessage() plus Ed25519 —
    // no access to this module's internals.
    const externalSignature = vectorKeypair
      .sign(Buffer.from(TESTNET_MESSAGE, "utf8"))
      .toString("base64");

    expect(externalSignature).toBe(TESTNET_SIGNATURE);
    expect(
      verifyResolutionReport(
        {
          payload: vectorPayload,
          signature: externalSignature,
          publicKey: VECTOR_PUBLIC_KEY,
          version: CURRENT_SIGNATURE_VERSION,
        },
        TESTNET
      )
    ).toBe(true);
  });

  it("still verifies the frozen pre-#978 legacy vector outside production", () => {
    const legacyMessage = JSON.stringify({
      domain: "vatix.oracle-resolution.v1",
      payload: {
        marketId: vectorPayload.marketId,
        outcome: vectorPayload.outcome,
        timestamp: vectorPayload.timestamp,
      },
    });
    const legacySignature =
      "d4MvjTpsgNciqDt6CeE7OckYkMLXwp01XK2GlTksu7Nm8+q4Oxi7yZA0tu9lz8qo4ob5lkoptwwceyHX8KcmCw==";

    expect(
      vectorKeypair.sign(Buffer.from(legacyMessage, "utf8")).toString("base64")
    ).toBe(legacySignature);

    const legacyReport: SignedResolutionReport = {
      payload: vectorPayload,
      signature: legacySignature,
      publicKey: VECTOR_PUBLIC_KEY,
      version: 1,
    };

    expect(verifyResolutionReport(legacyReport)).toBe(true);
  });
});
