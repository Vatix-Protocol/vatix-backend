# Architecture (Draft)

> This is an early-stage draft. Details will evolve as the system matures.

## System Overview

Vatix Backend is a monorepo of services that together power the Vatix prediction market protocol on Stellar.

```
                        ┌─────────────┐
  HTTP clients ────────▶│   API (src) │
                        └──────┬──────┘
                               │ reads/writes
                        ┌──────▼──────┐
                        │  PostgreSQL │◀──────────────────┐
                        └──────▲──────┘                   │
                               │ writes                   │ writes
                        ┌──────┴──────┐          ┌────────┴───────┐
                        │   Indexer   │          │    Workers     │
                        │(apps/indexer│          │(apps/workers)  │
                        └──────┬──────┘          └────────┬───────┘
                               │ polls                    │ consumes
                        ┌──────▼──────┐          ┌────────▼───────┐
                        │  Stellar    │          │     Redis      │
                        │  Network   │          │  (job queues)  │
                        └─────────────┘          └────────────────┘
                                                          ▲
                        ┌─────────────┐                   │ enqueues
                        │   Oracle   │───────────────────▶│
                        │(apps/oracle)│
                        └─────────────┘
```

## Service Boundaries

| Module        | Directory       | Responsibility                                                                                                  |
| ------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| **API**       | `src/`          | HTTP server (Fastify). Handles order placement, market queries, position reads. Owns the CLOB matching engine.  |
| **Indexer**   | `apps/indexer/` | Polls Stellar network for on-chain events, parses them, and writes canonical records to PostgreSQL.             |
| **Oracle**    | `apps/oracle/`  | Fetches external price/resolution data, signs reports, and submits them on-chain via the Stellar SDK.           |
| **Workers**   | `apps/workers/` | Queue consumers and scheduled jobs (e.g. settlement, expiry sweeps). Decoupled from the HTTP request lifecycle. |
| **Shared DB** | `packages/db/`  | Shared Prisma client and migration utilities used by all services.                                              |

## Major Data Flows

All public HTTP routes are mounted under `/v1`. The canonical positions read is
`GET /v1/wallets/:wallet/positions`; the older
`GET /positions/user/:address` root path is a temporary deprecation redirect.

### Order placement

1. Client `POST /v1/orders` → API validates and writes order to PostgreSQL
2. CLOB matching engine runs synchronously; fills are written in the same transaction
3. Matched fills are enqueued to Redis for downstream settlement by Workers

### Submission queue

The API and Oracle submit asynchronous work into Redis-backed queues that are processed by the Workers service.
This submission queue decouples real-time HTTP request handling from downstream settlement and finalization.

Workers consume queue entries and perform background tasks such as trade settlement, expiry sweeps, and resolution candidate processing.

### Market resolution

1. Oracle fetches external outcome data and signs a resolution report
2. Oracle submits the report on-chain (Stellar)
3. Indexer detects the on-chain event and writes a `ResolutionCandidate` to PostgreSQL
4. Workers pick up the candidate, apply the challenge window, and settle positions

### Indexer cursor

- The Indexer stores a `ledger_cursor` in PostgreSQL (`IndexerCursor` table) to resume from the last processed ledger after restarts.

## Open Decisions

- [x] **Queue technology**: Resolved — BullMQ selected. See [docs/adr/001-queue-technology.md](adr/001-queue-technology.md). Settlement and oracle submission queues migrated to BullMQ Workers with unified retry/backoff/DLQ config.
- [ ] **Oracle multi-provider strategy**: `fallback-adapter.ts` exists but the failover policy (timeout, retry count) is not finalised.
- [ ] **Monorepo build tooling**: Services currently share `tsconfig.json` at the root. Evaluate per-package tsconfigs as the repo grows.
- [ ] **Authentication**: Admin routes use a static key guard (`adminGuard.ts`). A proper auth layer is needed before public launch.
- [x] **Workers deployment**: resolved — the root [`Dockerfile`](../Dockerfile) defines `finalization-worker` and `oracle-worker` build targets, and [`docker-compose.yml`](../docker-compose.yml) runs them under the `workers` profile. No standalone process manager is used; each container runs a single process and relies on Docker/Kubernetes restart policies. See [docs/docker-compose.md](docker-compose.md).

## Assumptions

- All services share a single PostgreSQL instance (separate schemas are not used)
- Redis is used exclusively for caching and job queues (no persistence guarantees relied upon)
- Stellar Horizon is the only chain data source; no EVM chains are in scope
