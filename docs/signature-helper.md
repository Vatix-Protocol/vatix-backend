# Signature Helper

The Oracle Signature Helper provides Ed25519 signing and verification utilities for oracle resolution reports. It uses the Stellar Keypair primitive, ensuring that the same key material works seamlessly with on-chain submission.

## Resolution Payload

The data payload that is signed for a resolution report includes:

- `marketId`: The ID of the market being resolved.
- `outcome`: The resolved outcome (`true` for YES, `false` for NO).
- `timestamp`: ISO timestamp of the resolution.

## Canonicalisation

Before signing, the payload is converted into a deterministic canonical string. Keys are sorted so the same data always serializes identically.

## Message Bytes for Signers

External signers and verifiers (anyone re-implementing `signResolutionReport`/`verifyResolutionReport` outside this codebase) need the exact bytes that get signed, not just a description of the payload shape.

**There is no keccak (or any other) pre-hash step.** The Ed25519 signature in `signature` is computed directly over the raw UTF-8 bytes of a canonical JSON string — `Keypair.sign()` hashes internally as part of Ed25519, but callers never hash the payload themselves before calling it.

### Exact construction

1. Build a plain object with exactly these three keys, in exactly this order: `marketId` (string), `outcome` (boolean), `timestamp` (string, ISO-8601). No other keys, and no reordering — `JSON.stringify` on a plain object preserves insertion order for string keys, and the order here happens to also be alphabetical (`marketId` < `outcome` < `timestamp`), which is what "keys are sorted" above refers to.
2. Serialize with `JSON.stringify`, exactly as Node's implementation does it: no extra whitespace, booleans as bare `true`/`false`, strings double-quoted with standard JSON escaping.
3. Encode the resulting string as UTF-8. These bytes are the message.
4. Sign those bytes with the Stellar/Ed25519 keypair (`keypair.sign(message)`), base64-encode the 64-byte signature, and pair it with the signer's Stellar public key (`G...`).

### Worked example

Payload:

```json
{
  "marketId": "market-abc123",
  "outcome": true,
  "timestamp": "2026-06-29T00:00:00.000Z"
}
```

Canonical string (this exact string, no surrounding whitespace):

```
{"marketId":"market-abc123","outcome":true,"timestamp":"2026-06-29T00:00:00.000Z"}
```

UTF-8 bytes (82 bytes total, hex):

```
7b22 6d61 726b 6574 4964 223a 226d 6172
6b65 742d 6162 6331 3233 222c 226f 7574
636f 6d65 223a 7472 7565 2c22 7469 6d65
7374 616d 7022 3a22 3230 3236 2d30 362d
3239 5430 303a 3030 3a30 302e 3030 305a
227d
```

These are the bytes a third-party signer must produce and sign to be verifiable by `verifyResolutionReport`, and the bytes any external verifier must reconstruct from a market's `marketId`, `outcome`, and `timestamp` to check a signature independently of this codebase.

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
