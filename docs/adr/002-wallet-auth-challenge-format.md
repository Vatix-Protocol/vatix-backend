# ADR 002 — Wallet Auth Challenge Format: Expiry and Nonce Store

**Status:** Accepted
**Date:** 2026-07-29
**Issue:** [#804](https://github.com/Vatix-Protocol/vatix-backend/issues/804) (ties to [#740](https://github.com/Vatix-Protocol/vatix-backend/issues/740))

---

## Context

Wallet-authenticated writes (e.g. `POST /v1/orders`) require the caller to prove
ownership of a Stellar keypair by signing a challenge. This ADR records the
message format, expiry, nonce storage, and replay-prevention rules implemented
in `src/api/middleware/nonceStore.ts` and `src/api/middleware/stellarAuth.ts`,
so the design intent is documented alongside the code.

## Decision

### Message fields

The signed payload is a JSON object with alphabetically sorted keys
(`buildSignableMessage` in `stellarAuth.ts`):

| Field         | Source               | Notes                               |
| ------------- | -------------------- | ----------------------------------- |
| `marketId`    | request body         | target market                       |
| `nonce`       | `x-nonce` header     | single-use, issued by the challenge |
| `outcome`     | request body         | `YES` / `NO`                        |
| `price`       | request body         |                                     |
| `quantity`    | request body         |                                     |
| `side`        | request body         | `buy` / `sell`                      |
| `timestamp`   | `x-timestamp` header | ms since epoch                      |
| `userAddress` | request body         | Stellar public key                  |

Required headers on the authenticated request: `x-signature` (base64 Ed25519
signature of the message), `x-timestamp`, `x-nonce`.

### Expiry

- Challenge/nonce TTL defaults to **120 seconds**, configurable via
  `CHALLENGE_TTL_SECONDS`.
- Independently, the signed request's `x-timestamp` must be within **±5
  minutes** (`TIMESTAMP_TOLERANCE_MS`) of server time, rejecting stale
  signatures even if a nonce were somehow still valid.

### Nonce store

- Nonces are stored in **Redis** (shared across API replicas), keyed
  `auth:nonce:{userAddress}:{nonce}`, so a challenge issued by one replica is
  redeemable against any replica and disappears automatically via Redis TTL —
  no separate cleanup job.

### Replay rules

1. The signature must verify against the exact message (including nonce and
   timestamp) before the nonce is touched.
2. The nonce is consumed only _after_ signature verification succeeds, via an
   atomic Redis `DEL`-if-exists (`consumeNonce`). The delete reply count
   guarantees exactly one winner if two requests race on the same nonce.
3. Unknown, expired, or already-consumed nonces fail closed (401), as does a
   valid signature over an expired timestamp.

## Consequences

- A challenge is single-use and cannot outlive `CHALLENGE_TTL_SECONDS`.
- No nonce cleanup job is required; Redis TTL handles expiry.
- Any future change to the signable field set must update this ADR and the
  `buildSignableMessage` implementation together to avoid drift.
