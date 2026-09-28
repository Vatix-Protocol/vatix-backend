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

## Operations runbook

The oracle polls resolvable markets, resolves each through the provider chain, signs the
result, stores an `OracleReport` and enqueues it on the BullMQ `oracle-submissions` queue.
It never submits on-chain itself: the
[oracle submission worker](../workers/README.md#oracle-submission-worker-705) does. Deep-dive
incident procedures live in the [incident runbook](../../docs/runbooks/incident-runbook.md).

### Start and stop

| How            | Command                                                          |
| -------------- | ---------------------------------------------------------------- |
| Host           | `pnpm oracle:start` (watch mode: `pnpm oracle:dev`)              |
| Docker Compose | `docker compose --profile oracle up -d --build` (`vatix-oracle`) |
| Docker image   | `docker build --target oracle -t vatix-oracle .`                 |

`SIGTERM`, `SIGINT` and `SIGHUP` trigger a graceful shutdown: the scheduler stops, the
in-flight poll is drained so a signed resolution is never dropped, then the queue, Postgres and
Redis are closed. Teardown is force-exited after 30 s.

### Configuration

Invalid values fail startup with an `OracleConfigError` (`ORACLE_CONFIG_*` code) instead of
falling back to a default.

| Env var                                                           | Default                   | Description                                                                    |
| ----------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`, `REDIS_URL`                                       | —                         | Postgres (markets, reports) and Redis (submission queue)                       |
| `ORACLE_SECRET_KEY`                                               | —                         | Signing key (`S…`). Required: every poll fails without it                      |
| `ORACLE_SIGNER_PUBLIC_KEY`                                        | —                         | Pinned signer (`G…`); must match `ORACLE_SECRET_KEY`. Set in every env         |
| `ORACLE_PRIMARY_URL`                                              | `http://localhost:9001`   | Primary resolution provider                                                    |
| `ORACLE_FALLBACK_URLS` / `ORACLE_FALLBACK_URL`                    | `http://localhost:9002`   | Fallback provider(s), comma-separated. Ignored in production                   |
| `ORACLE_PRIMARY_TIMEOUT_MS`, `ORACLE_FALLBACK_TIMEOUT_MS`         | `30000`                   | Per-provider timeout, at most 120000                                           |
| `ORACLE_POLL_INTERVAL_MS`                                         | `30000`                   | Poll interval, 5000–3600000                                                    |
| `ORACLE_LOG_LEVEL`                                                | `info`                    | Log verbosity                                                                  |
| `SUBMISSION_QUEUE_NAME`                                           | `oracle-submissions`      | Queue the resolutions are enqueued on; must match the submission worker        |
| `ORACLE_HEALTH_PORT`, `ORACLE_HEALTH_HOST`, `ORACLE_HEALTH_TOKEN` | unset, `127.0.0.1`, unset | Opt-in health server (see [Health Routes](#health-routes-routeshealthts-1116)) |

### Health and signals

- Liveness `GET /health` and readiness `GET /health/ready` (Postgres + Redis) are available
  only when `ORACLE_HEALTH_PORT` is set.
- Each resolved market logs `Market resolved and enqueued`; failures log
  `Failed to resolve market` with the market id and never the key.
- `All providers unreachable — total provider outage` means the oracle failed closed for that
  market (`vatix_oracle_fail_closed_total` is incremented); nothing was signed or enqueued.
- Results with confidence below 0.75 are rejected rather than signed.

### Common failures

| Symptom                                                  | Likely cause                                                 | Action                                                                                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup fails with `ORACLE_CONFIG_SIGNER_MISMATCH`       | The wrong network's keypair was loaded                       | Load the key matching `ORACLE_SIGNER_PUBLIC_KEY`; see [docs/oracle-key-rotation.md](../../docs/oracle-key-rotation.md).                                     |
| Every poll logs `ORACLE_SECRET_KEY is required`          | Signing key missing                                          | Provide the key from the secret store; generate one with `pnpm generate:keypair` for non-production only.                                                   |
| Repeated total provider outage for a market              | Primary provider down (production has no fallback by design) | Restore the provider; if the challenge window is at risk follow [Incident 5](../../docs/runbooks/incident-runbook.md#incident-5-oracle-resolution-failure). |
| Reports created but nothing reaches chain                | Submission worker down or its queue backed up                | [Incident 6](../../docs/runbooks/incident-runbook.md#incident-6-queue-backlog-settlement--oracle-submission).                                               |
| `SUBMISSION_QUEUE_IDEMPOTENCY_CONFLICT` in logs          | Same submission id enqueued with a different payload         | Do not force it through; compare the two reports before deciding which one is correct.                                                                      |
| `Skipping oracle poll because a previous poll is active` | A poll takes longer than `ORACLE_POLL_INTERVAL_MS`           | Lower provider timeouts or raise the interval.                                                                                                              |

### Kill switches and rollback

- Stopping the oracle stops new resolutions only; already-enqueued submissions stay in the queue
  and are still processed by the submission worker. Stop that worker too to halt on-chain writes.
- Re-running a poll is safe: submission ids are derived from the resolution
  ([Submission Queue Idempotency](#submission-queue-idempotency-submission-queuets-1114)), so a
  replayed cycle cannot enqueue a second submission.
- Roll back by redeploying the previous image. Rotate a compromised key with
  [docs/oracle-key-rotation.md](../../docs/oracle-key-rotation.md) rather than reusing it.

See [SECURITY.md](../../SECURITY.md) for the deny-by-default policy on privileged surfaces.
