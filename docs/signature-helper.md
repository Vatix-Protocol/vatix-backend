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

## Test Vectors (#1148)

`apps/oracle/signature-helper.test.ts` freezes a known-answer vector set so any
other implementation (contract tests, web client, another service) can be
checked byte-for-byte against this repository.

Vector keypair — deterministic and **test-only** (Ed25519 seed = 32 bytes of
`0x07`; never a deployment key):

```
public key:  GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57
```

Payload:

```json
{
  "marketId": "market-vector-001",
  "outcome": false,
  "timestamp": "2026-06-29T00:00:00.000Z"
}
```

Frozen message and Base64 signature on **testnet**:

```
{"domain":"vatix.oracle-resolution.v1","network":"Test SDF Network ; September 2015","payload":{"marketId":"market-vector-001","outcome":false,"timestamp":"2026-06-29T00:00:00.000Z"}}
```

```
LQ7YleBIxfi0H6I86dd9I2X5ArPVU6vOmfmGiUDe7jGkJMUfUPCTxzmX6KYtdjeZQNvw5jPnKOw8LohjFQIsDA==
```

Frozen signature for the same payload on **mainnet**
(`"network":"Public Global Stellar Network ; September 2015"`):

```
r393T0RBHVFrvTOrBZKe5CVhNAi03WE+f4x6roXnv6+GZqQWB0IUOeGCIIRokoF6toOblcs8/AJUsKZrUXrHDg==
```

Frozen **legacy (pre-#978, `version: 1`)** message and signature — kept only so
the migration window can be verified; production rejects these:

```
{"domain":"vatix.oracle-resolution.v1","payload":{"marketId":"market-vector-001","outcome":false,"timestamp":"2026-06-29T00:00:00.000Z"}}
```

```
d4MvjTpsgNciqDt6CeE7OckYkMLXwp01XK2GlTksu7Nm8+q4Oxi7yZA0tu9lz8qo4ob5lkoptwwceyHX8KcmCw==
```

Reproducing a vector only needs Ed25519 plus the exported
`buildResolutionMessage(payload, networkPassphrase)` from
`apps/oracle/signature-helper.ts` — no access to module internals. A verifier
must also rebuild the same envelope and may pass the network passphrase
explicitly:

```typescript
import {
  buildResolutionMessage,
  verifyResolutionReport,
} from "../apps/oracle/signature-helper";

const message = buildResolutionMessage(
  payload,
  "Test SDF Network ; September 2015"
);
const isValid = verifyResolutionReport(
  report,
  "Test SDF Network ; September 2015"
);
```

When a vector fails, the signature contract changed (payload key order, domain
tag, or network binding). Fix the implementation, do **not** update the vector
in the same breath — the vector is the contract.

## Signature Envelope Versioning (#993)

`SignedResolutionReport` carries a `version` field:

- **`2`** (current, `CURRENT_SIGNATURE_VERSION`): the envelope described
  above — domain **and** network-passphrase separated. `signResolutionReport`
  always stamps new reports with `version: 2`.
- **`1`** (legacy) or a missing `version`: a pre-#978 signature, computed
  over `{"domain": ..., "payload": ...}` **without** the network passphrase.
  These signatures verify identically on any Stellar network, which means a
  testnet resolution report can be replayed as a valid mainnet one (or vice
  versa) — a cross-network replay attack.

`verifyResolutionReport` treats `version: 1` / missing `version` as legacy:

- In `NODE_ENV=production`, it **throws `LegacySignatureRejectedError`**
  rather than silently falling back to the weaker legacy check. Production
  must never accept a passphrase-less signature.
- Outside production, legacy reports are still verified (using the pre-#978
  canonical form) to support a migration window, and each verification logs
  an `oracle.legacy_signature_verified` warning.

Any oracle key rotation or resigning workflow should re-sign outstanding
legacy reports with `signResolutionReport` (which always emits `version: 2`)
before production cutover.
