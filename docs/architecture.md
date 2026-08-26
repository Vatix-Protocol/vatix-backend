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

| Module      | Directory       | Responsibility                                                                                                  |
| ----------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| **API**     | `src/`          | HTTP server (Fastify). Handles order placement, market queries, position reads. Owns the CLOB matching engine.  |
| **Indexer** | `apps/indexer/` | Polls Stellar network for on-chain events, parses them, and writes canonical records to PostgreSQL.             |
| **Oracle**  | `apps/oracle/`  | Fetches external price/resolution data, signs reports, and submits them on-chain via the Stellar SDK.           |
| **Workers** | `apps/workers/` | Queue consumers and scheduled jobs (e.g. settlement, expiry sweeps). Decoupled from the HTTP request lifecycle. |
| **Shared**  | `packages/shared/` | Cross-package types and utilities (logging, queue config, market lifecycle). TypeScript project references prevent direct imports across service boundaries. |

## Major Data Flows

All public HTTP routes are mounted under `/v1`. The canonical positions read is
`GET /v1/wallets/:wallet/positions`; the older
`GET /positions/user/:address` root path is a temporary deprecation redirect.

### Order placement

1. Client `POST /v1/orders` → API validates and writes order to PostgreSQL
2. CLOB matching engine runs synchronously; fills are written in the same transaction
3. Matched fills are enqueued to Redis for downstream settlement by Workers

**Single-writer enforcement.** The API is horizontally scaled, but only one
API process may match orders at a time — two processes both hydrating and
matching against the same in-memory book would produce inconsistent books
and double fills. Every API process competes for a Redis-backed leader lease
with a monotonic fencing token (`src/matching/leader-lease.ts`). Only the
current lease holder hydrates order books and accepts `POST /v1/orders`;
every other process fails closed with `503 matching_unavailable`. On lease
loss (handover or Redis partition) the losing process invalidates its
in-memory books immediately rather than continuing to serve them as
authoritative. See
[Scaling the API / matching leader lease](deployment-runbook.md#scaling-the-api--matching-leader-lease)
for operator-facing details and the `vatix_matching_leader` metric.
Order cancellation is intentionally not gated by the lease — it is protected
independently by version-conditioned (optimistic-concurrency) DB writes and
stays available from any instance.

### Submission queue

The API and Oracle submit asynchronous work into Redis-backed queues that are processed by the Workers service.
This submission queue decouples real-time HTTP request handling from downstream settlement and finalization.

Workers consume queue entries and perform background tasks such as trade settlement, expiry sweeps, and resolution candidate processing.

### Market resolution

1. Oracle fetches external outcome data and signs a resolution report
2. Oracle submits the report on-chain (Stellar)
3. Indexer detects the on-chain event and writes a `ResolutionCandidate` to PostgreSQL
4. Workers pick up the candidate, apply the challenge window, and settle positions

### Market lifecycle

Market status transitions (`ACTIVE → RESOLVED | CANCELLED`, both terminal) are
defined once in `packages/shared/src/marketLifecycle.ts` and enforced by the
admin status route, order validation, the oracle scheduler, the indexer parser
and the finalization worker. See [docs/market-lifecycle.md](market-lifecycle.md)
for the state diagram, transition matrix and per-path enforcement behaviour.

### Indexer cursor

- The Indexer stores a `ledger_cursor` in PostgreSQL (`IndexerCursor` table) to resume from the last processed ledger after restarts.

## Open Decisions

- [x] **Queue technology**: Resolved — BullMQ selected. See [docs/adr/001-queue-technology.md](adr/001-queue-technology.md). Settlement and oracle submission queues migrated to BullMQ Workers with unified retry/backoff/DLQ config.
- [ ] **Oracle multi-provider strategy**: `fallback-adapter.ts` exists but the failover policy (timeout, retry count) is not finalised.
- [x] **Monorepo build tooling**: Resolved — TypeScript project references now enforce per-package boundaries. The API, Indexer, Oracle, and Workers packages each have their own `tsconfig.json` with explicit `references` edges; cross-package deep imports are prevented at build time. Shared code lives in `packages/shared/`. See [#942](https://github.com/Vatix-Protocol/vatix-backend/issues/942).
- [x] **Authentication**: Resolved — admin routes now use rotatable per-identity credentials (`AdminIdentity` model) instead of a static shared token. Each identity is independently revocable, rotatable, and auditable via `AdminIdentityAuditLog`. Break-glass operations remain an explicit, audited path via `AdminApprovalToken` dual-control. In production, the identity store must be configured and reachable; missing config fails fast. See `src/services/admin-identity.ts` and `src/api/middleware/adminGuard.ts`.
- [x] **Workers deployment**: resolved — the root [`Dockerfile`](../Dockerfile) defines `finalization-worker` and `oracle-worker` build targets, and [`docker-compose.yml`](../docker-compose.yml) runs them under the `workers` profile. No standalone process manager is used; each container runs a single process and relies on Docker/Kubernetes restart policies. See [docs/docker-compose.md](docker-compose.md).

## Assumptions

- All services share a single PostgreSQL instance (separate schemas are not used)
- Redis is used exclusively for caching and job queues (no persistence guarantees relied upon)
- Stellar Horizon is the only chain data source; no EVM chains are in scope
