# Workers

Background execution module for queue consumers and scheduled jobs.

Workers handle tasks that must run outside the HTTP request lifecycle: settlement sweeps,
expiry processing, and any other async work enqueued by the API or Oracle.

## Scope

| Concern             | Description                                                                        |
| ------------------- | ---------------------------------------------------------------------------------- |
| **Queue consumers** | Process jobs pushed to Redis / BullMQ by the API or Oracle (e.g. trade settlement) |
| **Scheduled jobs**  | Cron-style tasks such as market expiry sweeps and position reconciliation          |

## Workers

### Settlement consumer (`src/settlement/consumer.ts`)

Consumes trade-settlement jobs from a BullMQ queue backed by Redis. Each job carries a
`SettlementJobPayload` and, when Stellar credentials are present, submits a `settle_trade`
transaction to the on-chain contract.

**Required environment variables**

| Variable                     | Description                                      | Required for on-chain |
| ---------------------------- | ------------------------------------------------ | --------------------- |
| `REDIS_URL`                  | Redis connection string (e.g. `redis://…`)       | Yes                   |
| `SETTLEMENT_QUEUE_NAME`      | BullMQ queue name (default: `settlement-trades`) | No                    |
| `REDIS_KEY_PREFIX`           | Key namespace prefix (default: `vatix:`)         | No                    |
| `STELLAR_RPC_URL`            | Soroban RPC endpoint                             | Yes                   |
| `SETTLEMENT_CONTRACT_ID`     | Deployed contract address                        | Yes                   |
| `SOROBAN_NETWORK_PASSPHRASE` | Network passphrase for signing                   | Yes                   |
| `STELLAR_SECRET_KEY`         | Signer keypair secret                            | Yes                   |
| `LOG_LEVEL`                  | Pino log level (default: `info`)                 | No                    |

If the four Stellar variables are absent the worker still runs and processes jobs but logs a
warning and skips the on-chain call (off-chain only mode, useful for local development).

### Finalization worker (`src/finalization/`)

Sweeps markets whose `endTime` has passed and triggers resolution finalization.

### Oracle worker (`src/oracle/`)

Relays oracle price submissions to the Soroban contract via a BullMQ submission queue.

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
# Settlement consumer only
docker compose --profile settlement-worker up -d --build

# All workers
docker compose --profile workers up -d --build

# Full stack (API + indexer + all workers)
docker compose --profile app up -d --build
```

## Structure

```
apps/workers/
├── src/
│   ├── consumers/        # Shared queue consumer helpers
│   │   ├── dead-letter.ts
│   │   └── queue-consumer.ts
│   ├── finalization/     # Market expiry / finalization loop
│   ├── oracle/           # Oracle submission queue consumer
│   ├── settlement/       # Trade settlement consumer (BullMQ)
│   │   ├── bullmq-consumer.ts
│   │   ├── consumer.ts          ← entrypoint
│   │   └── settlement-worker.ts
│   ├── routes/
│   │   └── ready.ts      # /ready health-check route
│   └── shared/
│       └── queue-config.ts
└── README.md
```

## Adding a Worker

1. Create a consumer in `src/<name>/` following the pattern in `src/settlement/`.
2. Add a pnpm script in the root `package.json` (`workers:<name>` and `workers:<name>:dev`).
3. Add a Docker stage in `Dockerfile` and a service in `docker-compose.yml`.
4. Document the queue name, payload shape, and required env vars in this README.
