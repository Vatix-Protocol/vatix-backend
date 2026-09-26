# Oracle Module

## Purpose

Handles resolution-provider integrations and workflows.

## Responsibilities

- External data sourcing
- Resolution logic coordination

## Constraints

- No dependency on API internals
- Keep interfaces minimal

## Provider Failure Policy

Provider retries use the shared `src/services/providerRetry.ts` budget. The
oracle `maxRetries` setting counts retries after the initial call and defaults
to `0`.

Fallback providers are available in development and test. When
`NODE_ENV=production`, the oracle disables fallback and fails closed on any
primary provider failure, so no secondary, stale, or default off-chain value
can be signed or submitted.

## Signature Helper (`signature-helper.ts`, #1113)

Resolution reports are Ed25519-signed, domain-separated and bound to the
Stellar network passphrase (`#978`). Two further rules apply:

- **Payload validation** — a payload with an empty/over-long market id, a
  non-boolean outcome or an unparseable timestamp is rejected
  (`ORACLE_SIGNATURE_INVALID_PAYLOAD`) _before_ any key is touched.
- **Trusted-signer pinning** — a report carries its own `publicKey`, so a bare
  signature check would accept a self-signed report from any key. Verification
  therefore requires a pinned signer: `ORACLE_SIGNER_PUBLIC_KEY` (or an explicit
  `expectedPublicKey` argument). In production, verifying without a pinned
  signer throws `ORACLE_SIGNATURE_TRUSTED_SIGNER_REQUIRED` rather than
  trusting the report's own key.

Set `ORACLE_SIGNER_PUBLIC_KEY` in every deployed environment (signer and
verifier alike). A malformed value fails closed, and when
`ORACLE_SECRET_KEY` is also set the two must match — a mismatch
(`ORACLE_CONFIG_SIGNER_MISMATCH`) is the signal that the wrong network's
keypair was loaded. See `docs/oracle-key-rotation.md`.

## Config Validation (`oracle-config.ts`, #1115)

`loadOracleConfig()` fails closed: every _present_ variable must parse and stay
within its bounds (`OracleConfigError` carries a stable `code` and a
`correlationId`, and never embeds key material). Beyond the pre-existing
checks it validates:

- `ORACLE_SECRET_KEY` must be a Stellar secret key (`S…`), and the derived
  public key is exposed as `signerPublicKey` (safe to log).
- `ORACLE_SIGNER_PUBLIC_KEY` must be a Stellar account id (`G…`) and must match
  `signerPublicKey` when both are set.
- `ORACLE_CHALLENGE_WINDOW_SECONDS` ≤ 30 days and provider timeouts ≤ 120 s, so
  a unit mix-up (ms where seconds were meant) is caught at startup.

Use `describeOracleConfig(config)` for startup logs — it reduces the secret to
a boolean and never returns it.

## Submission Queue Idempotency (`submission-queue.ts`, #1114)

The enqueue `id` is the queue's deduplication key and **must** be derived with
`buildSubmissionIdempotencyKey({ marketId, oracleAddress, resolvedAt })` — a
pure function of the resolution, never of `Date.now()`. A duplicated poll
cycle, a crash/replay or a second producer then collapses to the same key and
the replay is a no-op instead of a possible second on-chain submission.

Replaying an id with a _different_ payload is a conflict, not a replay: the
queue logs `Oracle submission idempotency conflict` and raises the
non-retryable `SUBMISSION_QUEUE_IDEMPOTENCY_CONFLICT` (409), leaving the live
entry untouched. Pass `idempotencyConflict: "return-existing"` to restore the
previous "keep the first entry" behaviour.

## Health Routes (`routes/health.ts`, #1116)

`GET /health` is liveness (no dependency access, always 200); `GET /health/ready`
is readiness and fails closed with `503` / `DEPENDENCY_UNAVAILABLE` when
Postgres or Redis is unavailable. Both are served by an opt-in health server
that only starts when `ORACLE_HEALTH_PORT` is set. Full details, including
`ORACLE_HEALTH_TOKEN` authz and the Kubernetes snippet, are in
`docs/health-probes.md`.
