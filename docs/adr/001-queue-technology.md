# ADR 001 — Queue Technology: BullMQ vs Redis Streams vs SQS

**Status:** Accepted  
**Date:** 2026-06-20  
**Issue:** [#452](https://github.com/Debbys-design/vatix-backend/issues/452)  
**Closes open decision in:** `docs/architecture.md`

---

## Context

The architecture doc listed this as an open decision:

> **Queue technology**: Redis (BullMQ) is assumed for Workers but not yet implemented.
> Evaluate whether a managed queue (SQS, etc.) is preferable before first production deploy.

The current codebase uses ad-hoc Redis Streams patterns (`xadd`/`xreadgroup`/`xack`) written directly
in `apps/workers/src/settlement/consumer.ts` and `apps/workers/src/oracle/redis-submission-queue.ts`.
Each consumer re-implements retry counting, backoff, dead-letter logging, and visibility timeouts
in an inconsistent way. This ADR evaluates three options and records the decision.

---

## Options Considered

### Option A — BullMQ

BullMQ is a Node.js queue library built on Redis. It provides:

- **Unified job lifecycle**: pending → active → completed / failed, with automatic retry and backoff.
- **Dead-letter queue (DLQ)**: failed jobs move to a `failed` set; accessible via dashboard or API.
- **Concurrency control** and **rate limiting** at the queue level.
- **Repeatable/scheduled jobs** via `QueueScheduler`.
- **TypeScript-first** API with full type inference on job data.
- **Single Redis connection** — no separate infrastructure.
- **BullMQ Board** optional UI for observability.

Tradeoffs:
- Adds `bullmq` dependency (well-maintained, MIT licence).
- Jobs are stored as Redis hashes; slightly higher memory per job than raw streams.
- Requires Redis ≥ 6.2 (already satisfied by the `redis:7-alpine` service in `docker-compose.yml`).

### Option B — Raw Redis Streams (status quo)

The current approach manually wraps `XADD`/`XREADGROUP`/`XACK`/`XCLAIM`.

- No additional dependency.
- Full control over stream semantics.
- Must re-implement: retry backoff, DLQ, concurrency, job state tracking, observability — all by hand.
- Already showing divergence between settlement and oracle consumers (different retry logic, different
  visibility timeout approaches).

### Option C — Amazon SQS

Managed cloud queue with at-least-once delivery, DLQ support, and long-polling.

- Eliminates operational Redis queue concerns.
- Introduces AWS SDK dependency and requires an AWS account / IAM setup.
- Local development requires LocalStack or mocking.
- Adds network round-trip latency vs in-process Redis.
- Significant infrastructure change out of scope for the current mono-Redis deployment.

---

## Decision

**BullMQ** is selected.

The project already runs Redis and the existing ad-hoc stream consumers are re-implementing
exactly what BullMQ provides — badly and inconsistently. BullMQ gives a single, well-tested
abstraction for retry/backoff/DLQ that all queues (settlement, oracle submission) can share.
SQS is ruled out because it introduces cloud infrastructure coupling before the system has
reached production; it can be revisited if operational requirements change.

---

## Consequences

1. Add `bullmq` to root `package.json` dependencies.
2. Replace `apps/workers/src/settlement/consumer.ts` raw-stream bootstrap with a BullMQ `Worker`.
3. Replace `apps/workers/src/oracle/redis-submission-queue.ts` with a BullMQ `Queue` producer and
   `Worker` consumer pair.
4. Unified retry config: `attempts`, `backoff` strategy, and `removeOnFail` (DLQ retention) defined
   once per queue in a shared config object.
5. `queue-consumer.ts` generic `processJob` function is preserved — BullMQ workers call it so
   existing unit tests continue to pass without modification.
6. The `SETTLEMENT_QUEUE_NAME` and `SUBMISSION_QUEUE_NAME` env vars continue to control queue names.

---

## Unified Retry / Backoff / DLQ Config

```ts
// Shared defaults — override per queue as needed
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { count: 100 },   // keep last 100 completed jobs
  removeOnFail: false,                 // keep ALL failed jobs as DLQ
} as const;
```

Failed jobs (DLQ) are accessible via:
```ts
const failed = await queue.getFailed();
```
