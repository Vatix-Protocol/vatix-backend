# Workers

Background execution module for queue consumers and scheduled jobs.

Workers handle tasks that must run outside the HTTP request lifecycle: settlement sweeps,
expiry processing, and any other async work enqueued by the API or Oracle.

## Scope

| Concern             | Description                                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| **Queue consumers** | Process jobs pushed to Redis / BullMQ by the API or Oracle (e.g. trade settlement) |
| **Scheduled jobs**  | Cron-style tasks such as market expiry sweeps and position reconciliation          |

## Implemented Workers

### Oracle Submission Worker (#705)

Listens on a BullMQ queue (`oracle-submissions`) for signed oracle resolution reports and submits them on-chain via the Stellar smart contract's `resolve_market` method.

| Config env var               | Default              | Description                               |
| ---------------------------- | -------------------- | ----------------------------------------- |
| `SUBMISSION_QUEUE_NAME`      | `oracle-submissions` | BullMQ queue name                         |
| `STELLAR_RPC_URL`            | —                    | Stellar RPC endpoint                      |
| `SOROBAN_NETWORK_PASSPHRASE` | —                    | Network passphrase                        |
| `ORACLE_SECRET_KEY`          | —                    | Signer secret key for on-chain submission |
| `INDEXER_CONTRACT_ID`        | —                    | Target contract ID                        |

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

| Config env var              | Default | Description                                                      |
| --------------------------- | ------- | ---------------------------------------------------------------- |
| `EXPIRY_WORKER_INTERVAL_MS` | `60000` | How often the job runs (ms). Minimum 1000.                       |
| `EXPIRY_WORKER_MAX_RUN_MS`  | `30000` | Max wall-clock time (ms) per poll before stopping. 0 = unlimited |
| `LOG_LEVEL`                 | `info`  | Log verbosity: `debug` \| `info` \| `warn` \| `error`.           |

**Metrics emitted**:

- `markets_expired_total` — count of markets transitioned to CANCELLED
- `orders_cancelled_on_expiry_total` — count of orders cancelled during sweep
- `collateral_released_on_expiry_total` — total collateral released (in collateral units)

### Reconciliation Worker (#880)

Polls all `ACTIVE` and `RESOLVED` markets, detects divergence between indexed events (`IndexedTrade`, `CollateralDeposit`) and stored `UserPosition` rows, and optionally applies recovery by recomputing positions from source events.

**Purpose**: Ensures that indexed on-chain events are correctly reflected in position tracking. Detects incomplete trades, missing deposits, and race conditions.

| Config env var               | Default | Description                                                      |
| ---------------------------- | ------- | ---------------------------------------------------------------- |
| `RECONCILIATION_INTERVAL_MS` | `30000` | How often the job runs (ms). Minimum 1000.                       |
| `RECONCILIATION_MAX_RUN_MS`  | `20000` | Max wall-clock time (ms) per poll before stopping. 0 = unlimited |
| `AUTO_RECOVERY_ENABLED`      | `false` | Whether to automatically apply recovery for detected drift       |

**Metrics emitted**:

- `positions_reconciled_total` — count of wallets examined
- `positions_drift_detected` — count of wallets with divergence
- `positions_recovered_total` — count of successful recovery applications

#### Queue Consumer Pattern

The finalization worker uses a **poll-based** approach: it queries the database on each tick for candidates that satisfy the challenge window cutoff. Future workers for real-time settlement will instead subscribe to Redis Streams produced by the API after order matching.

```
API (order match) ──xadd──▶ Redis Stream ──xreadgroup──▶ Worker consumer
                                                              │
                                                         writes result
                                                              │
                                                        PostgreSQL
```

## Structure

```
apps/workers/
├── src/
│   ├── expiry/
│   │   ├── config.ts    # Env-based config loader
│   │   ├── job.ts       # ExpiryJob class
│   │   ├── main.ts      # Entry point / bootstrap
│   │   └── types.ts     # Type definitions
│   ├── finalization/
│   │   ├── config.ts         # Env-based config loader
│   │   ├── job.ts            # FinalizationJob class
│   │   ├── challenge.ts      # Challenge/dispute write path (same lock order as job.ts)
│   │   ├── resolutionLock.ts # Shared SELECT ... FOR UPDATE row-locking helper
│   │   └── main.ts           # Entry point / bootstrap
│   └── ...
└── README.md
```

## Running

### With pnpm (host machine)

```bash
# One-shot (production-style)
pnpm workers:settlement

# Watch mode (development)
pnpm workers:settlement:dev
```

### With Docker Compose

```bash
# Development (hot reload)
pnpm workers:finalization:dev

# Production
pnpm workers:finalization:start
```

## Adding a Worker

1. Create a consumer in `src/consumers/<name>.ts` or a scheduler in `src/schedulers/<name>.ts`
2. Register it in `src/index.ts`
3. Document the queue name, payload shape, and env config in this README
