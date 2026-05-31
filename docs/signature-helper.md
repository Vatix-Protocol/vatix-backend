# Signature Helper

The Oracle Signature Helper provides Ed25519 signing and verification utilities for oracle resolution reports. It uses the Stellar Keypair primitive, ensuring that the same key material works seamlessly with on-chain submission.

## Resolution Payload

The data payload that is signed for a resolution report includes:
- `marketId`: The ID of the market being resolved.
- `outcome`: The resolved outcome (`true` for YES, `false` for NO).
- `timestamp`: ISO timestamp of the resolution.

## Canonicalisation

Before signing, the payload is converted into a deterministic canonical string. Keys are sorted so the same data always serializes identically.

## Usage

### Signing a Report

```typescript
import { signResolutionReport } from "../apps/oracle/signature-helper";

const payload = {
  marketId: "12345",
  outcome: true,
  timestamp: new Date().toISOString()
};

const signedReport = signResolutionReport(payload, process.env.ORACLE_SECRET_KEY);
```

### Verifying a Report

```typescript
import { verifyResolutionReport } from "../apps/oracle/signature-helper";

const isValid = verifyResolutionReport(signedReport);
```
