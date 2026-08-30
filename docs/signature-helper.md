# Signature Helper

The Oracle Signature Helper provides Ed25519 signing and verification utilities for oracle resolution reports. It uses the Stellar Keypair primitive, ensuring that the same key material works seamlessly with on-chain submission.

## Resolution Payload

The data payload that is signed for a resolution report includes:

- `marketId`: The ID of the market being resolved.
- `outcome`: The resolved outcome (`true` for YES, `false` for NO).
- `timestamp`: ISO timestamp of the resolution.

## Canonicalisation

Before signing, the payload is wrapped in a **domain- and network-separated
envelope** (#978) and that envelope is serialised to a deterministic canonical
string. Keys are listed explicitly so the same data always serialises
identically.

### Domain separation (#978)

The signature is computed over a wrapper object, never the bare payload:

```json
{
  "domain": "vatix.oracle-resolution.v1",
  "network": "<Stellar network passphrase>",
  "payload": { "marketId": "...", "outcome": true, "timestamp": "..." }
}
```

- **`domain`** is the constant string `vatix.oracle-resolution.v1`. The
  off-chain order-receipt signer (`src/services/signing.ts`) uses a different
  tag (`vatix.order-receipt.v1`), so an order-receipt signature can never be
  replayed as an oracle-resolution signature or vice versa.
- **`network`** is the active Stellar network passphrase
  (`SOROBAN_NETWORK_PASSPHRASE`). A testnet signature therefore does not
  verify on mainnet. In `NODE_ENV=production` this variable is **required** —
  `signResolutionReport` / `verifyResolutionReport` throw
  `SigningDomainConfigError` rather than fall back to the local stub
  passphrase (`Test SDF Network ; September 2015`), which is used only outside
  production. Callers may pass an explicit passphrase as the third argument to
  override resolution.

Shared implementation: `packages/shared/src/signingDomain.ts`
(`buildDomainSeparatedMessage`, `resolveSigningNetworkPassphrase`).

## Message Bytes for Signers

External signers and verifiers (anyone re-implementing `signResolutionReport`/`verifyResolutionReport` outside this codebase) need the exact bytes that get signed, not just a description of the payload shape.

**There is no keccak (or any other) pre-hash step.** The Ed25519 signature in `signature` is computed directly over the raw UTF-8 bytes of a canonical JSON string — `Keypair.sign()` hashes internally as part of Ed25519, but callers never hash the payload themselves before calling it.

### Exact construction

1. Build the inner payload object with exactly these three keys, in exactly this order: `marketId` (string), `outcome` (boolean), `timestamp` (string, ISO-8601).
2. Wrap it in the envelope object with exactly these three keys, in this order: `domain` (the constant `"vatix.oracle-resolution.v1"`), `network` (the Stellar network passphrase string), `payload` (the object from step 1).
3. Serialize the envelope with `JSON.stringify`, exactly as Node's implementation does it: no extra whitespace, booleans as bare `true`/`false`, strings double-quoted with standard JSON escaping.
4. Encode the resulting string as UTF-8. These bytes are the message.
5. Sign those bytes with the Stellar/Ed25519 keypair (`keypair.sign(message)`), base64-encode the 64-byte signature, and pair it with the signer's Stellar public key (`G...`).

### Worked example

Inner payload:

```json
{
  "marketId": "market-abc123",
  "outcome": true,
  "timestamp": "2026-06-29T00:00:00.000Z"
}
```

Canonical string on Stellar **testnet** (this exact string, no surrounding whitespace):

```
{"domain":"vatix.oracle-resolution.v1","network":"Test SDF Network ; September 2015","payload":{"marketId":"market-abc123","outcome":true,"timestamp":"2026-06-29T00:00:00.000Z"}}
```

The same inner payload on **mainnet** (`"network":"Public Global Stellar Network ; September 2015"`) produces a different canonical string, and therefore a different, non-interchangeable signature.

These are the bytes a third-party signer must produce and sign to be verifiable by `verifyResolutionReport`, and the bytes any external verifier must reconstruct (including the correct `domain` tag and `network` passphrase) to check a signature independently of this codebase.

## Usage

### Signing a Report

```typescript
import { signResolutionReport } from "../apps/oracle/signature-helper";

const payload = {
  marketId: "12345",
  outcome: true,
  timestamp: new Date().toISOString(),
};

const signedReport = signResolutionReport(
  payload,
  process.env.ORACLE_SECRET_KEY
);
```

### Verifying a Report

```typescript
import { verifyResolutionReport } from "../apps/oracle/signature-helper";

const isValid = verifyResolutionReport(signedReport);
```
