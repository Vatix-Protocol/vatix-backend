# ADR 002: Stellar auth challenge, nonce TTL and key layout

## Status

Accepted

## Context

Order routes proved wallet ownership with an Ed25519 signature over the request
body plus an `x-timestamp` header inside a ±5 minute skew window. A skew window
alone does not stop replay: a captured request can be resent to every API
replica until the window closes, and any in-memory nonce map neither survives a
restart nor federates across replicas.

## Decision

Auth is a challenge-response flow backed by Redis, which every API replica
already shares.

- `POST /v1/auth/challenge` takes `{ userAddress }` and returns a server-issued
  nonce (24 random bytes, base64url) plus its expiry.
- The nonce is stored under `auth:nonce:<userAddress>:<nonce>` with a TTL, on
  top of the global `REDIS_KEY_PREFIX` namespace.
- The nonce is part of the canonical signed message and is echoed in the
  `x-nonce` header, so it cannot be swapped after signing.
- `verifyStellarSignature` consumes the nonce with a single `DEL` **after** the
  signature verifies. `DEL` returns the number of keys removed, so concurrent
  double-submits — including ones landing on different replicas — produce
  exactly one winner; a forged signature cannot burn a valid challenge.

### Expiry policy

| Setting                 | Default | Meaning                                     |
| ----------------------- | ------- | ------------------------------------------- |
| `CHALLENGE_TTL_SECONDS` | `120`   | Nonce lifetime; expired nonces fail closed. |
| Timestamp skew          | 5 min   | Unchanged; applied before nonce lookup.     |

The TTL is deliberately shorter than the skew window: expiry is enforced by
Redis, so a missing key is indistinguishable from a used one and both are
rejected.

## Consequences

- Failures return `401` with the standard auth error envelope
  (`code: "UNAUTHORIZED"`): missing `x-nonce`, unknown/expired/used nonce, and
  nonce store unavailable (fail closed).
- Clients must fetch a challenge per mutating request; `scripts/load-test-orders.ts`
  does this inline before each order.
- Redis becomes a hard dependency of order placement, in line with the existing
  readiness probe.

## Alternatives considered

- **Timestamp window only** — rejected; does not prevent replay.
- **Postgres nonce table** — rejected; adds a write per request and needs a
  sweeper, while Redis TTL expires keys for free.
