# Workers

Background execution module for queue consumers and scheduled jobs.

Workers handle tasks that must run outside the HTTP request lifecycle: trade settlement,
oracle submission, resolution finalization, market expiry, position reconciliation and
audit archiving. Each worker is a separate process; see [Operations runbook](#operations-runbook)
for how to run, monitor and roll them back.

## Scope

| Concern             | Description                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------- |
| **Queue consumers** | Process BullMQ jobs pushed to Redis by the API or Oracle (settlement, oracle submission) |
| **Scheduled jobs**  | Interval-polled tasks: finalization, market expiry, reconciliation, audit archiving      |

## Implemented Workers

### Oracle Submission Worker (#705)

Listens on a BullMQ queue (`oracle-submissions`) for signed oracle resolution reports and submits them on-chain via the Stellar smart contract's `resolve_market` method.

| Config env var                               | Default              | Description                                                          |
| -------------------------------------------- | -------------------- | -------------------------------------------------------------------- |
| `SUBMISSION_QUEUE_NAME`                      | `oracle-submissions` | BullMQ queue name                                                    |
| `STELLAR_RPC_URL` / `STELLAR_RPC_URLS`       | —                    | Stellar RPC endpoint(s)                                              |
| `SOROBAN_NETWORK_PASSPHRASE`                 | —                    | Network passphrase; must match `STELLAR_NETWORK` (default `testnet`) |
| `ORACLE_SECRET_KEY`                          | —                    | Signer secret key for on-chain submission                            |
| `INDEXER_CONTRACT_ID` / `MARKET_CONTRACT_ID` | —                    | Target contract ID                                                   |

With `NODE_ENV=production` the worker refuses to start if any of the Stellar settings above is
missing. Outside production it logs a warning and runs with `resolve_market` calls disabled.
On startup it reconciles submissions a previous process left broadcast-but-unconfirmed before
taking new jobs (see `src/oracle/submission-reconciliation.ts`).

**Docker**: `docker build --target oracle-worker -t vatix-oracle-worker .`

**Docker Compose profile**: `oracle-worker` (included in `app` / `full`)

### Finalization Worker

Polls for `ResolutionCandidate` rows that have passed the challenge window and promotes them to a settled `Resolution`.

| Config env var                          | Default | Description                                                                             |
| --------------------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `FINALIZATION_INTERVAL_MS`              | `60000` | How often the job runs (ms). Minimum 1000.                                              |
| `FINALIZATION_CHALLENGE_WINDOW_SECONDS` | `3600`  | How long (seconds) a candidate must be in `PROPOSED` status before it can be finalized. |
| `FINALIZATION_LOG_LEVEL`                | `info`  | Log verbosity: `debug` \| `info` \| `warn` \| `error`.                                  |

#### Finalize / challenge mutual exclusion (locking order)

A `ResolutionCandidate` has exactly one legal winner: it is either finalized
(`PROPOSED` → `ACCEPTED`, with a `Resolution` row created) or challenged
(`PROPOSED` → `CHALLENGED`, no `Resolution` row). Without DB-level locking, a
challenge write racing the finalization tick could commit _after_ the
finalize transaction had already read `status: PROPOSED` but before it
wrote `ACCEPTED` — finalizing a market that was in fact disputed, or leaving
a `Resolution` row for a candidate that ends up `CHALLENGED`.

Both writers avoid this the same way, via `apps/workers/src/finalization/resolutionLock.ts`:

1. Open a DB transaction.
2. `SELECT id, status FROM resolution_candidates WHERE id = $1 FOR UPDATE` —
   locks the single candidate row for the rest of the transaction. Postgres
   blocks a second transaction's `FOR UPDATE` on the same row until the
   first commits or rolls back, so this is what actually serializes the two
   writers — the outer `challengeWindowSeconds` check is only a pre-filter,
   not the safety mechanism.
3. Re-check the locked row's `status === "PROPOSED"` _inside_ the
   transaction. If it isn't (a concurrent writer already committed), abort:
   finalize marks the candidate `skipped`; challenge throws
   `IllegalChallengeTransitionError`.
4. Only if the recheck passes, write the transition (`Resolution` + market +
   candidate status for finalize; candidate status for challenge) and a
   `ResolutionAuditLog` row (`action: "FINALIZE" | "CHALLENGE"`) in the same
   transaction, then commit.

Neither path locks any other table before locking `resolution_candidates`,
so there is no lock-ordering deadlock between the two flows. See
`apps/workers/src/finalization/job.ts` (finalize) and
`apps/workers/src/finalization/challenge.ts` (challenge/dispute) for the
implementations, and `tests/integration/finalization-challenge-race.test.ts`
for concurrent tests against a real Postgres instance (including the
challenge-window boundary).

### Expiry Worker

Polls for `ACTIVE` markets with `endTime <= now()` and transitions them to `CANCELLED` status. Cancels all remaining resting orders (`OPEN`/`PARTIALLY_FILLED`), releases locked collateral, and invalidates in-memory order books.

**Production criticality**: Prevents stale liquidity from resting after expiry, avoids locked collateral incidents, and ensures no late matches race oracle flows.

| Config env var                   | Default                        | Description                                                      |
| -------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `EXPIRY_WORKER_INTERVAL_MS`      | `60000`                        | How often the job runs (ms). Minimum 1000.                       |
| `EXPIRY_WORKER_MAX_RUN_MS`       | `30000`                        | Max wall-clock time (ms) per poll before stopping. 0 = unlimited |
| `EXPIRY_CLOCK_SKEW_TOLERANCE_MS` | `5000` in production, else `0` | Grace period after `endTime` before a market is expired          |
| `LOG_LEVEL`                      | `info`                         | Log verbosity: `debug` \| `info` \| `warn` \| `error`.           |

**Signals**: each poll logs `Expiry job completed` with `totalCandidates`, `expiredCount`,
`erroredCount`, `skippedCount` and `durationMs`.

### Reconciliation Worker (#880)

Polls all `ACTIVE` and `RESOLVED` markets, detects divergence between indexed events (`IndexedTrade`, `CollateralDeposit`) and stored `UserPosition` rows, and optionally applies recovery by recomputing positions from source events.

**Purpose**: Ensures that indexed on-chain events are correctly reflected in position tracking. Detects incomplete trades, missing deposits, and race conditions.

| Config env var               | Default | Description                                                      |
| ---------------------------- | ------- | ---------------------------------------------------------------- |
| `RECONCILIATION_INTERVAL_MS` | `30000` | How often the job runs (ms). Minimum 1000.                       |
| `RECONCILIATION_MAX_RUN_MS`  | `20000` | Max wall-clock time (ms) per poll before stopping. Minimum 1000. |
| `AUTO_RECOVERY_ENABLED`      | `false` | Whether to automatically apply recovery for detected drift       |
| `RECONCILIATION_DRY_RUN`     | `false` | Detect and log drift without writing any recovery                |

**Signals**: each poll logs `Reconciliation job completed` with `marketCount`, `failedMarkets`,
`totalWallets`, `driftDetected`, `recovered` and `dryRun`.

### Settlement Worker

Consumes the BullMQ settlement queue fed by the API's transactional outbox and settles matched
trades on-chain. It also runs the outbox publisher, which re-enqueues outbox rows left
`PENDING`/`FAILED` after a crash or Redis outage. Retry, quarantine and replay mechanics are in
[docs/queue-consumer.md](../../docs/queue-consumer.md).

| Config env var                         | Default             | Description                                                     |
| -------------------------------------- | ------------------- | --------------------------------------------------------------- |
| `SETTLEMENT_QUEUE_NAME`                | `settlement-trades` | Queue name, prefixed with `REDIS_KEY_PREFIX` (default `vatix:`) |
| `STELLAR_RPC_URL` / `STELLAR_RPC_URLS` | —                   | Stellar RPC endpoint(s)                                         |
| `SETTLEMENT_CONTRACT_ID`               | —                   | Settlement contract ID                                          |
| `SOROBAN_NETWORK_PASSPHRASE`           | —                   | Network passphrase                                              |
| `STELLAR_SECRET_KEY`                   | —                   | Signer secret key for settlement transactions                   |
| `SETTLEMENT_QUARANTINE_THRESHOLD`      | `1`                 | Permanent failures for one trade before it is quarantined       |
| `LOG_LEVEL`                            | `info`              | Log verbosity                                                   |

With `NODE_ENV=production` the worker refuses to start with incomplete Stellar settings.

### Audit Archiver Worker

Drains the Redis trade-audit stream into Postgres (`trade_audit_events`) and, when enabled,
prunes archived history. Retention settings and their fail-closed rules are in
[docs/audit-archiver-retention.md](../../docs/audit-archiver-retention.md).

| Config env var                 | Default | Description                                            |
| ------------------------------ | ------- | ------------------------------------------------------ |
| `AUDIT_ARCHIVER_INTERVAL_MS`   | `30000` | How often the job runs (ms). Minimum 1000.             |
| `AUDIT_ARCHIVER_MAX_RUN_MS`    | `20000` | Max wall-clock time (ms) per poll. 0 = unlimited       |
| `AUDIT_ARCHIVER_BATCH_SIZE`    | `1000`  | Stream entries archived per batch                      |
| `AUDIT_ARCHIVE_RETENTION_DAYS` | `0`     | Days of archived history to keep; `0` disables pruning |

**Signals**: each poll logs `Audit archiver worker poll complete` with `archivedCount`,
`erroredCount`, `archiveLagMs` and `purgedCount`.

### Queue consumers vs. poll-based jobs

Finalization, expiry, reconciliation and audit archiving are **poll-based**: each tick queries
Postgres (or the audit stream) for due work, and a tick is skipped while the previous one is
still running. Settlement and oracle submission are **BullMQ consumers**: retry, backoff and
dead-lettering come from the shared job options in `packages/shared/src/queue-config.ts`.

```
API (order match) ──outbox──▶ BullMQ settlement queue ──▶ Settlement worker ──▶ Stellar
Oracle (resolve)  ──enqueue─▶ BullMQ oracle-submissions ─▶ Oracle submission worker ──▶ Stellar
```

## Structure

```
apps/workers/
├── src/
│   ├── audit-archiver/   # Audit stream → Postgres archiver (+ retention)
│   ├── consumers/        # Shared queue-consumer and dead-letter helpers
│   ├── expiry/           # Market expiry sweep
│   ├── finalization/
│   │   ├── job.ts            # FinalizationJob class
│   │   ├── challenge.ts      # Challenge/dispute write path (same lock order as job.ts)
│   │   ├── resolutionLock.ts # Shared SELECT ... FOR UPDATE row-locking helper
│   │   └── main.ts           # Entry point / bootstrap
│   ├── oracle/           # Oracle submission worker (BullMQ) + crash reconciliation
│   ├── reconciliation/   # Position reconciliation
│   ├── settlement/       # Settlement worker (BullMQ) + error classification
│   ├── health-server.ts  # /live and /ready server for worker entrypoints
│   └── routes/           # /live and /ready route handlers
└── README.md
```

Each scheduled worker directory follows the same layout: `config.ts` (env loader),
`job.ts` (one poll), `main.ts` (bootstrap, interval, graceful shutdown).

## Operations runbook

All workers need `DATABASE_URL`; the queue consumers, the audit archiver and the oracle submission
worker also need `REDIS_URL` (TLS/ACL options: [docs/queue-consumer.md](../../docs/queue-consumer.md)).
Deep-dive incident procedures live in the
[incident runbook](../../docs/runbooks/incident-runbook.md); this section is the per-worker
entry point.

### Start and stop

| Worker            | Start (host)                                        | Watch mode                                        | Docker target / Compose service |
| ----------------- | --------------------------------------------------- | ------------------------------------------------- | ------------------------------- |
| Settlement        | `pnpm workers:settlement:start`                     | `pnpm workers:settlement:dev`                     | `settlement-worker`             |
| Oracle submission | `pnpm workers:submission:start`                     | `pnpm workers:submission:dev`                     | `oracle-worker`                 |
| Finalization      | `pnpm workers:finalization:start`                   | `pnpm workers:finalization:dev`                   | `finalization-worker`           |
| Expiry            | `pnpm --filter @vatix/workers expiry:start`         | `pnpm --filter @vatix/workers expiry:dev`         | —                               |
| Reconciliation    | `pnpm --filter @vatix/workers reconciliation:start` | `pnpm --filter @vatix/workers reconciliation:dev` | —                               |
| Audit archiver    | `pnpm --filter @vatix/workers audit-archiver:start` | `pnpm --filter @vatix/workers audit-archiver:dev` | —                               |

Compose: `docker compose --profile workers up -d --build` starts the three containerized
workers; a single one can be started by its service name as a profile
(e.g. `--profile settlement-worker`).

Every worker stops cleanly on `SIGTERM`/`SIGINT`: it stops scheduling new work and drains the
in-flight poll or job before exiting. All workers except reconciliation then close
Postgres/Redis and force-exit if teardown exceeds 30 s
([docs/graceful-shutdown.md](../../docs/graceful-shutdown.md)). Prefer `docker stop` /
`kill -TERM` over `SIGKILL` so a settlement or finalization transaction is never abandoned
mid-flight.

### Health

The Compose services have a liveness healthcheck that asserts PID 1 is still the worker's
entrypoint (`docker compose ps` shows `unhealthy` otherwise). `src/health-server.ts` provides
`GET /live` and `GET /ready` for Kubernetes probes, started with `startHealthServer(logger, port)`
from a worker entrypoint ([docs/health-probes.md](../../docs/health-probes.md)). Never point a
worker's probes at the API's `/v1/health`.

Beyond liveness, check that each worker is making progress: poll-based workers log a completion
line every interval (see **Signals** above), and the queue consumers log
`Settlement job completed` / `Oracle submission processed` per job.

### Common failures

| Symptom                                                                                   | Likely cause                                                      | Action                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker exits at startup with `Production startup requires complete Stellar configuration` | Missing Stellar env in production (fail-closed by design)         | Set the variables named in the error; do not relax `NODE_ENV`.                                                                                                              |
| Settlement or oracle queue `wait`/`failed` counts grow                                    | Worker down, Stellar RPC or Postgres unavailable, or a poison job | [Incident 6: Queue Backlog](../../docs/runbooks/incident-runbook.md#incident-6-queue-backlog-settlement--oracle-submission); retry with `pnpm dlq` once the cause is fixed. |
| Oracle submission jobs fail with `AmbiguousSubmissionError`                               | Tx broadcast but not yet confirmed                                | Let BullMQ retry: it re-checks chain status instead of resubmitting. Verify on-chain before touching the DB.                                                                |
| Candidates stay `PROPOSED`/`CHALLENGED` past the window                                   | Finalization worker down or its polls failing                     | [Incident 7](../../docs/runbooks/incident-runbook.md#incident-7-stuck-challenged-resolution-candidates).                                                                    |
| Duplicate settlement or finalization suspected                                            | Race between writers                                              | [Incident 8](../../docs/runbooks/incident-runbook.md#incident-8-duplicate-settlement--finalization-race).                                                                   |
| `Skipping … poll because a previous poll is active` repeats                               | A poll takes longer than its interval                             | Raise the interval or lower `*_MAX_RUN_MS`; check Postgres latency.                                                                                                         |
| `driftDetected` > 0 in reconciliation logs                                                | Positions diverge from indexed events                             | Investigate with `RECONCILIATION_DRY_RUN=true` first; enable `AUTO_RECOVERY_ENABLED` only after review.                                                                     |

### Kill switches and rollback

- Every worker can be stopped independently (`docker compose stop <service>` or stopping its
  process). Queue consumers keep their jobs in Redis while stopped, and the settlement outbox
  keeps unpublished trades in Postgres, so stopping loses no work; it only delays it.
- `AUTO_RECOVERY_ENABLED=false` (default) and `RECONCILIATION_DRY_RUN=true` keep reconciliation
  read-only. `AUDIT_ARCHIVE_RETENTION_DAYS=0` (default) disables audit pruning.
- To roll back a worker release, redeploy the previous image or commit for that worker only;
  the queue payloads and outbox rows are consumed by the rolled-back version as-is.

### Security

Signer secrets (`ORACLE_SECRET_KEY`, `STELLAR_SECRET_KEY`) and connection URLs come from the
environment only and are never logged. Mainnet deployments require the passphrase and
`STELLAR_NETWORK` to agree (the oracle submission worker refuses to start otherwise). See
[SECURITY.md](../../SECURITY.md) for the deny-by-default policy.

## Adding a Worker

1. Create `src/<name>/` with `config.ts`, `job.ts` and `main.ts`, following the existing workers
   (overlap-guarded poll, `createShutdown` teardown that drains in-flight work).
2. Add `<name>:dev` / `<name>:start` scripts to `apps/workers/package.json`, and a Dockerfile
   target plus Compose service if it runs in containers.
3. Document its config, signals and failure modes in this README and its
   [Operations runbook](#operations-runbook) rows.
