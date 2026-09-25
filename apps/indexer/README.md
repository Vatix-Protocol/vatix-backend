# Indexer

The indexer consumes Stellar ledger events and projects them into the
backend read models. It is the source of truth for ledger-derived state
(balances, swaps, settlement) and must fail closed whenever that source
of truth is unreachable.

## Startup health

The indexer validates its configuration and critical dependencies before
binding an HTTP server.  The startup pipeline is:

1. **Env validation** (`validateEnv`) — fail-closed on missing or
   invalid `SOROBAN_NETWORK_PASSPHRASE`; mainnet requires explicit
   `VATIX_ALLOW_MAINNET=true` opt-in.
2. **Config-shape health** (`checkStartupHealth`) — validates cursor,
   networkId, cursorKey, and `DATABASE_URL` before the indexer starts
   polling.  Returns stable error codes, never values.
3. **Live dependency probes** (`checkLiveDependencies`) — optional
   real I/O checks (DB, Horizon/RPC) that run in production or when
   `INDEXER_HTTP_FORCE_LIVE_CHECK=true`.  Retries with backoff to
   tolerate startup jitter.
4. **HTTP server** (`buildIndexerHttpServer`) — starts only after all
   gates pass.  Binds only when `INDEXER_HTTP_ENABLED=true`.

### Error codes

| Code | Meaning |
| --- | --- |
| `ENV_MISSING` | Required environment variable not set. |
| `ENV_INVALID` | Environment variable has an invalid value. |
| `ENV_UNSAFE_MAINNET` | Mainnet passphrase without `VATIX_ALLOW_MAINNET=true`. |
| `RATE_LIMITED` | Request exceeds the per-endpoint rate limit. |
| `DEPENDENCY_UNAVAILABLE` | Critical dependency (DB/Redis/RPC) unreachable. |
| `PROBE_TIMEOUT` | Dependency probe exceeded its timeout. |
| `UNAUTHORIZED` | Missing or invalid `x-principal` header on a data route. |

Every response carries a `correlationId` for log/trace stitching.
No secrets, connection strings, or credentials are ever surfaced in
probe responses or error messages.

### Feature flags

| Variable | Default | Effect |
| --- | --- | --- |
| `INDEXER_HTTP_ENABLED` | unset (disabled) | Opt-in to expose the HTTP server. |
| `INDEXER_HTTP_FORCE_LIVE_CHECK` | unset (false) | Run live dependency probes outside production. |
| `INDEXER_HTTP_PORT` | `3000` | Port for the HTTP server. |
| `INDEXER_CURSOR` | unset | Initial cursor for the ingestion loop. |
| `INDEXER_CURSOR_KEY` | `ingestion` | Cursor key for the indexer. |

## Stellar Wave contributors

See `SECURITY.md` for the deny-by-default policy on privileged surfaces
and the rate-limit/authorization requirements for every external
entrypoint. New privileged surfaces must be authorized and rate-limited
before landing.

See `docs/runbooks/incident-runbook.md` for operational runbooks and
`docs/health-probes.md` for probe design details.

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

## Cursor durability

`src/storage.ts` provides `PrismaCursorStorageClient` for durable
checkpointing of the indexer's ledger cursor. The cursor is the
indexer's bookmark into the Stellar blockchain and must advance
monotonically.

### Invariants

- **Cursor advances monotonically.** `saveCursor` rejects any value
  that would regress the stored cursor, throwing `CursorConflictError`.
  This prevents replayed or out-of-order requests from rewinding the
  indexer.
- **Batch writes and cursor saves are atomic.** `saveCursorWithBatch`
  wraps both the event batch write and the cursor advance in a single
  Prisma `$transaction`. If either side fails, the entire transaction
  rolls back so the cursor never advances without the data being
  persisted.
- **Fail closed on storage errors.** If the database is unreachable,
  `saveCursor`, `saveLedgerHash`, and `saveCursorWithBatch` propagate
  the error up to the ingestion loop, which halts rather than
  silently skipping the checkpoint.
- **Concurrent writers are detected.** When `saveCursorWithBatch` is
  called with an `expectedPreviousCursor`, it verifies that the
  current DB value matches before advancing. If a concurrent writer
  has already advanced the cursor, a `CursorConflictError` is thrown
  and the batch is rolled back.
- **No secrets in logs or metrics.** Cursor values are ledger sequence
  numbers (non-sensitive). Ledger hashes are truncated in log output.

### Error codes

| Code | Meaning |
| --- | --- |
| `CURSOR_CONFLICT` | Concurrent writer advanced the cursor; batch rolled back. |
| `CURSOR_STORAGE_CONFIG_ERROR` | Storage path misconfigured; fail fast. |
| `CURSOR_REGRESSION_REJECTED` | Replayed request would regress the cursor; denied. |

### Rollback

Cursor durability is a read/write surface that affects the indexer's
watermark. If a regression is detected, the indexer can be rolled back
by manually resetting the cursor in the `indexer_cursors` table. No
mainnet state is corrupted by a cursor rollback — only already-indexed
events are re-fetched and deduplicated by the idempotency layer.

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
