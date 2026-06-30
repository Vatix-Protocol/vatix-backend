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

### Finalization Worker

Polls for `ResolutionCandidate` rows that have passed the challenge window and promotes them to a settled `Resolution`.

| Config env var | Default | Description |
|---|---|---|
| `FINALIZATION_INTERVAL_MS` | `60000` | How often the job runs (ms). Minimum 1000. |
| `FINALIZATION_CHALLENGE_WINDOW_SECONDS` | `3600` | How long (seconds) a candidate must be in `PROPOSED` status before it can be finalized. |
| `FINALIZATION_LOG_LEVEL` | `info` | Log verbosity: `debug` \| `info` \| `warn` \| `error`. |

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
│   └── finalization/
│       ├── config.ts    # Env-based config loader
│       ├── job.ts       # FinalizationJob class
│       └── main.ts      # Entry point / bootstrap
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
