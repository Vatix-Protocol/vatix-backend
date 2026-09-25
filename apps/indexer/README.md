# Indexer

The indexer consumes Stellar ledger events and projects them into the
backend read models. It is the source of truth for ledger-derived state
(balances, swaps, settlement) and must fail closed whenever that source
of truth is unreachable.

## Gap detection

`src/gapDetector.ts` detects missing ledger ranges in the ingested event
stream. It is keyed on `ledgerSeq:eventIndex` so that replayed or
concurrent detection requests are idempotent.

### Invariants

- **Contiguous ranges produce no gap.** A stream with no missing
  `ledgerSeq` values reports `hasGap: false`.
- **Single and multi-ledger gaps are reported.** Any missing
  `ledgerSeq` between the observed minimum and maximum is surfaced with
  its `from`/`to` bounds.
- **Boundary gaps are reported.** Missing ledgers at the start or end of
  the observed window are included.
- **Adversarial and duplicate inputs are rejected or deduplicated.**
  Out-of-order, duplicated, and malformed entries never produce a false
  "no gap" result.
- **Fail closed on dependency outage.** If the RPC/DB/Redis source of
  truth is unreachable, detection must not report `hasGap: false`; it
  returns a stable error code instead.

### Error codes

| Code | Meaning |
| --- | --- |
| `GAP_DETECTION_SOURCE_UNAVAILABLE` | Source of truth (RPC/DB/Redis) unreachable; fail closed. |
| `GAP_DETECTION_INVALID_INPUT` | Malformed or adversarial input rejected. |
| `GAP_DETECTION_UNAUTHORIZED` | Caller lacks the required role. |

Every detection result carries a `correlationId` for tracing across the
indexer and backend logs. Logs and metrics never include secrets or raw
credentials.

### Fixtures

Deterministic vectors live in `fixtures/gap-detection-vectors.json` and
cover contiguous ranges, single/multi-ledger gaps, boundary gaps, and
adversarial/duplicate inputs. Unit tests in `src/gapDetector.test.ts`
assert the invariants above, including auth and idempotency negatives
(replayed and concurrent detection requests).

### Rollback

Gap detection is read-only and does not mutate money-path state. If a
regression is detected, disable the detector via its feature flag and
fall back to the previous behavior; no mainnet state is affected.

## HTTP surface

The indexer exposes a read-only HTTP surface for market data queries.
It is gated behind the `INDEXER_HTTP_ENABLED` feature flag and is
disabled by default.

### Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/markets` | List up to 100 active markets |
| GET | `/markets/:id` | Fetch a single active market by ID |

### CORS policy

CORS is configured via `CORS_ALLOWED_ORIGINS` (comma-separated list).
In production, all origins must use `https://`; an empty or unset
`CORS_ALLOWED_ORIGINS` results in a deny-by-default empty allowlist.
See `docs/cors.md` for the full policy.

### Authz

The indexer HTTP surface supports two optional authz gates:

| Env var | Header | Effect |
| ------- | ------ | ------ |
| `INDEXER_REQUIRED_PRINCIPAL` | `x-principal` | Must match the configured value |
| `INDEXER_API_KEY` | `x-api-key` | Must match the configured value |

If neither is configured the surface still starts (when enabled) but
logs a warning — this is a security gap for production deployments.

### Rate limiting

| Path | Limit | Window |
| ---- | ----- | ------ |
| `/markets` | 60 req/min | 60 s |
| `/markets/:id` | 120 req/min | 60 s |

Every response carries a `correlationId` for tracing.

## Safe JSON Parsing & Serialization (`safeJson.ts`)

`src/safeJson.ts` provides robust, production-grade JSON parsing (`safeJsonParse`)
and sanitization/serialization (`safeStringify`, `sanitizeForJson`) with built-in
protections against Denial of Service (DoS) and resource exhaustion attacks.

### Invariants

- **Maximum String Length**: Inputs exceeding `maxLength` (default: 1 MB) are
  rejected immediately without parsing.
- **Nesting Depth Limits**: JSON payloads or JavaScript objects exceeding
  `maxDepth` (default: 32 levels) are rejected or truncated to prevent stack
  overflow (`RangeError`).
- **Array & Object Size Limits**: Arrays exceeding `maxArrayLength` (default: 10,000)
  and objects exceeding `maxObjectKeys` (default: 10,000) are bounded or rejected.
- **Fail-Closed on Malformed Input**: `safeJsonParse` never throws an uncaught
  exception; it returns `{ ok: false, error: SyntaxError }` on any parsing or validation failure.
- **Ops-Safe**: Secrets and raw credentials are never leaked in logs or error messages.

## Stellar Wave contributors

See `SECURITY.md` for the deny-by-default policy on privileged surfaces
and the rate-limit/authorization requirements for every external
entrypoint. New privileged surfaces must be authorized and rate-limited
before landing.
