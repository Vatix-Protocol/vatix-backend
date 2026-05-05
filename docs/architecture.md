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

### Order placement

1. Client `POST /v1/orders` → API validates and writes order to PostgreSQL
2. CLOB matching engine runs synchronously; fills are written in the same transaction
3. Matched fills are enqueued to Redis for downstream settlement by Workers

### Market resolution

1. Oracle fetches external outcome data and signs a resolution report
2. Oracle submits the report on-chain (Stellar)
3. Indexer detects the on-chain event and writes a `ResolutionCandidate` to PostgreSQL
4. Workers pick up the candidate, apply the challenge window, and settle positions

### Indexer cursor

- The Indexer stores a `ledger_cursor` in PostgreSQL (`IndexerCursor` table) to resume from the last processed ledger after restarts.

## Open Decisions

- [ ] **Queue technology**: Redis (BullMQ) is assumed for Workers but not yet implemented. Evaluate whether a managed queue (SQS, etc.) is preferable before first production deploy.
- [ ] **Oracle multi-provider strategy**: `fallback-adapter.ts` exists but the failover policy (timeout, retry count) is not finalised.
- [ ] **Monorepo build tooling**: Services currently share `tsconfig.json` at the root. Evaluate per-package tsconfigs as the repo grows.
- [ ] **Authentication**: Admin routes use a static key guard (`adminGuard.ts`). A proper auth layer is needed before public launch.
- [ ] **Workers deployment**: No Dockerfile or process manager config exists for Workers yet.

## Assumptions

- All services share a single PostgreSQL instance (separate schemas are not used)
- Redis is used exclusively for caching and job queues (no persistence guarantees relied upon)
- Stellar Horizon is the only chain data source; no EVM chains are in scope
