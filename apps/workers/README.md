# Workers

Background execution module for queue consumers and scheduled jobs.

Workers handle tasks that must run outside the HTTP request lifecycle: settlement sweeps, expiry processing, and any other async work enqueued by the API or Oracle.

## Scope

| Concern | Description |
|---|---|
| **Queue consumers** | Process jobs pushed to Redis by the API or Oracle (e.g. trade settlement) |
| **Scheduled jobs** | Cron-style tasks such as market expiry sweeps and position reconciliation |

## Status

Module scaffolded. No queues or jobs are implemented yet.
See [docs/architecture.md](../../docs/architecture.md) for how Workers fit into the overall system.

## Structure (planned)

```
apps/workers/
├── src/
│   ├── consumers/   # One file per queue consumer
│   ├── schedulers/  # Cron / interval jobs
│   └── index.ts     # Entry point
└── README.md
```

## Running

```bash
# Not yet available — implementation pending
```

## Adding a Worker

1. Create a consumer in `src/consumers/<name>.ts` or a scheduler in `src/schedulers/<name>.ts`
2. Register it in `src/index.ts`
3. Document the queue name and payload shape in this README
