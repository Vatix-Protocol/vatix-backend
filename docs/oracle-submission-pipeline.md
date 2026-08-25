# Oracle Submission Pipeline

## Overview

The oracle submission pipeline provides a durable, BullMQ-backed system for resolving markets and submitting signed resolutions on-chain. It uses BullMQ for unified retry/backoff/DLQ management and at-least-once delivery semantics.

## Architecture

### Components

1. **OracleService** (`apps/oracle/oracle-service.ts`)
   - Resolves markets via primary/fallback providers
   - Optional: enqueues successful resolutions for submission
   - Tracks metrics (success/failure counts, retry attempts)

2. **BullMQSubmissionQueue** (`apps/workers/src/oracle/bullmq-submission-queue.ts`)
   - BullMQ Queue implementation for oracle submissions
   - Handles enqueue with content-based deduplication (market ID + payload hash)
   - Automatic retry with exponential backoff (3 attempts by default)
   - Dead-letter queue (DLQ) for failed submissions

3. **SubmissionWorker** (`apps/workers/src/oracle/submission-worker.ts`)
   - BullMQ Worker that processes pending submissions
   - Verifies signatures before submission
   - Submits signed resolutions on-chain (via Stellar SDK)
   - Updates OracleReport and ResolutionCandidate on success
   - Implements retry logic with exponential backoff via BullMQ
   - Dead-letters failed submissions via DLQ

4. **Oracle Main** (`apps/oracle/main.ts`)
   - Entrypoint for the oracle resolution polling
   - Uses BullMQSubmissionQueue to enqueue submissions
   - Manages bootstrap, polling loop, and graceful shutdown
   - Handles SIGINT/SIGTERM signals

## Deployment

### Starting the Oracle Worker

```bash
# Development (watch mode with tsx)
pnpm workers:oracle:dev

# Production (single run)
pnpm workers:oracle:start
```

### Environment Variables

```env
# Redis submission queue polling interval (ms)
# Valid range: 1000-60000, Default: 5000
ORACLE_SUBMISSION_POLL_INTERVAL_MS=5000

# Max submission attempts before dead-lettering
# Default: 3
ORACLE_SUBMISSION_MAX_RETRIES=3

# Visibility timeout for queued submissions (ms)
# Default: 300000 (5 minutes)
ORACLE_SUBMISSION_VISIBILITY_TIMEOUT_MS=300000

# Log level for oracle worker (debug|info|warn|error)
# Default: info
ORACLE_SUBMISSION_LOG_LEVEL=info

# Redis connection URL (required)
REDIS_URL=redis://localhost:6379

# PostgreSQL connection URL (required)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/vatix

# Stellar secret key for signing resolutions (required)
ORACLE_SECRET_KEY=SAAA...

# Challenge window duration for finalization (seconds)
# Default: 86400 (24 hours)
ORACLE_CHALLENGE_WINDOW_SECONDS=86400
```

## Data Flow

### Resolution → Enqueue

```
OracleService.resolve()
    ↓
Provider returns ProviderResult
    ↓
BullMQSubmissionQueue.enqueue()
    ↓
Compute jobId = marketId + payloadHash (first 16 chars)
    ↓
Check if job already exists (by jobId)
    ↓
If exists: skip (already processed)
If not exists:
  - Add to BullMQ queue: oracle-submissions
  - BullMQ applies DEFAULT_JOB_OPTIONS (3 attempts, exponential backoff)
  - Log enqueue event with jobId and correlation ID
```

### Dequeue → Submit → Persist

```
BullMQ Worker polls queue: oracle-submissions
    ↓
Receive Job<SubmissionQueueItem>
    ↓
Create SignedResolutionReport
    ↓
Verify signature (defensive check)
    ↓
submitOnChain() [Stellar SDK]
    ↓
Success:
  - Upsert OracleReport (status=SUBMITTED)
  - Upsert ResolutionCandidate (status=PROPOSED)
  - BullMQ marks job as completed
  - Log success with jobId
    ↓
Failure (retryable):
  - BullMQ automatically retries (up to 3 attempts)
  - Exponential backoff: 1s, 2s, 4s
  - Log retry warning
    ↓
Failure (max retries exceeded):
  - Mark OracleReport as FAILED
  - Job moved to DLQ (failed set)
  - Log dead-letter event
```

## Idempotency & Deduplication

The system prevents duplicate submissions through:

1. **Dedup Key**: `oracle:dedup:{marketId}:{payloadHash}`
   - TTL: 86400 seconds (24 hours)
   - Checked before enqueue; skip if exists

2. **Payload Hash**: SHA256(JSON.stringify(canonicalPayload))
   - Canonical ordering of payload fields ensures consistency
   - Detects duplicate resolutions automatically

3. **Visibility Timeout**: 300 seconds (5 minutes)
   - Prevents "stuck" submissions from blocking the queue indefinitely
   - Xclaim redelivers messages if worker crashes

## Crash Safety & Submission State Machine (#996)

Broadcasting a resolve_market transaction and durably recording its result
are two separate operations. If the worker process crashes, is OOM-killed,
or is redeployed between the two, the queue's at-least-once delivery
guarantee means the submission will be redelivered — and naively retrying
would rebuild and resend a brand new transaction, double-submitting the
resolution.

To make this crash-safe, every submission is tracked through a durable
state machine on `OracleReport`, keyed by the unique pair
`(market_id, payload_hash)` so every attempt for the same logical
submission converges on one row instead of inserting a new one per retry:

```
                 ┌──────────┐
   claim intent  │          │
  ──────────────►│ PENDING  │
                  │          │
                  └────┬─────┘
                       │ sendTransaction() returns a hash
                       │ (persisted immediately — before
                       │  confirmation is polled)
                       ▼
                  ┌──────────┐        getTransaction() → SUCCESS
                  │          │───────────────────────────────────┐
                  │SUBMITTED │                                    │
                  │          │──────────┐                         ▼
                  └────┬─────┘          │ definite            ┌───────────┐
                       │                │ non-inclusion        │ CONFIRMED │
                       │ ambiguous      │ (timebound expired,   └───────────┘
                       │ (NOT_FOUND,    │ ledger rejected)
                       │  still within  ▼
                       │  timebound)  ┌──────────┐
                       │   ▲          │ PENDING  │ (cleared txHash,
                       └───┘          │(re-armed)│  ready to resubmit)
                    re-check only,    └──────────┘
                    never resubmit

  max retries exceeded, from any non-CONFIRMED state
                       │
                       ▼
                  ┌──────────┐
                  │  FAILED  │  (dead-lettered)
                  └──────────┘
```

**Key rules:**

- **Durable intent before broadcast.** `claimSubmissionIntent` upserts the
  `PENDING` row keyed by `(marketId, payloadHash)` before any chain call is
  made, so even a submission that fails signature verification has a row to
  record the failure against.
- **Tx hash persisted the instant it's known.** The moment
  `sendTransaction()` returns a hash, it's written to `oracle_reports.tx_hash`
  with `status = SUBMITTED` and `broadcast_at = now()` — _before_ the worker
  starts polling for confirmation. This is what closes the crash window: a
  process death anywhere after this point leaves a durable, unambiguous
  record that a specific transaction is in flight.
- **Never resubmit while ambiguous.** If a submission is redelivered (retry,
  redeploy, restart) and its row is already `SUBMITTED` with a `txHash`, the
  worker checks that hash's on-chain status _before_ touching the chain
  again. A fresh transaction is only ever built when the prior one is
  either absent, or _definitely_ not included.
- **"Definite" non-inclusion, not "not found yet".** Stellar transactions
  carry a `setTimeout(30)` timebound. A `NOT_FOUND` result from
  `getTransaction` is ambiguous — the tx may not have propagated to this RPC
  node yet — until `broadcastAt + 30s` (plus a grace margin) has elapsed
  network-wide, at which point the tx can never be included and it's safe to
  clear the row for a fresh broadcast (`checkOnChainStatus` in
  `apps/workers/src/oracle/submission-reconciliation.ts`).
- **Startup reconciliation.** On boot, before processing any new jobs, the
  worker calls `reconcileInFlightSubmissions()`, which re-checks every
  `SUBMITTED` row against the chain and resolves it to `CONFIRMED` or clears
  it for retry. This is what recovers a submission left ambiguous by a
  crash in the previous process.
- **Idempotent short-circuit.** If a redelivered submission's row is already
  `CONFIRMED`, the worker acknowledges the queue message without touching
  the chain at all.

## Persistence

### OracleReport Table

Records signed resolutions submitted on-chain:

```sql
CREATE TABLE oracle_reports (
  id UUID PRIMARY KEY,
  market_id UUID NOT NULL,
  payload_hash VARCHAR(64) NOT NULL,
  source VARCHAR(256),         -- "oracle-service", "Chainlink", etc.
  confidence DECIMAL(5, 4),    -- 0.0-1.0
  candidate_resolution BOOLEAN, -- The proposed outcome
  status OracleReportStatus DEFAULT 'PENDING', -- PENDING | SUBMITTED | CONFIRMED | FAILED
  attempts INTEGER DEFAULT 0,
  tx_hash VARCHAR(64),          -- set the instant sendTransaction() returns a hash
  broadcast_at TIMESTAMP,       -- set alongside tx_hash, before confirmation is polled
  confirmed_at TIMESTAMP,       -- set once confirmation is observed on-chain
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX oracle_reports_market_id_payload_hash_key
ON oracle_reports(market_id, payload_hash);
```

### ResolutionCandidate Table

Records proposed outcomes for finalization:

```sql
CREATE TABLE resolution_candidates (
  id UUID PRIMARY KEY,
  market_id UUID NOT NULL,
  proposed_outcome BOOLEAN,
  source VARCHAR(256),
  status ResolutionCandidateStatus, -- PROPOSED, CHALLENGED, ACCEPTED, REJECTED
  operator_address VARCHAR(56),     -- Oracle's Stellar public key
  confidence_score DECIMAL(5, 4),
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

## Failure Handling

### Retryable Errors

- Network timeouts
- Transient Stellar RPC errors
- Database connection failures

**Action**: Increment attempt counter, xclaim to re-deliver

### Non-Retryable Errors

- Invalid signature
- Market not found
- Insufficient oracle balance on-chain
- Invalid outcome value

**Action**: Dead-letter immediately, record failure

### Dead-Lettering

Failed submissions that exceed `ORACLE_SUBMISSION_MAX_RETRIES` are:

1. Marked as FAILED in OracleReport
2. Removed from the active queue (xack)
3. Logged with full error context
4. Available for manual inspection via database queries

## Monitoring & Observability

### Key Metrics

- **Queue Depth**: Number of pending submissions
  - Source: BullMQ `queue.count()` or `queue.getWaitingCount()`
  - Via BullMQ Board: `/admin/queues/oracle-submissions`

- **Failed Jobs**: Number of submissions in DLQ
  - Source: BullMQ `queue.getFailedCount()` or `queue.getFailed()`
  - Indicates submissions that exceeded max retries

- **Processing Rate**: Completed submissions per minute
  - Source: Logs with `action: submission_processed`
  - Indicator of worker health

- **Submission Latency**: Time from enqueue to on-chain confirmation
  - Source: OracleReport.created_at to OracleReport.confirmed_at

- **Error Rate**: Failed submissions / total submissions
  - Source: Logs with level=error, action containing "failed"

- **`vatix_oracle_submission_ambiguous_total`** (Counter, #996): Number of
  broadcast submissions that could not be definitively classified as
  confirmed or non-included — either the poll loop timed out, a redelivery
  found an unconfirmed prior broadcast still within its timebound, or
  startup reconciliation couldn't resolve a `SUBMITTED` row. A sustained
  non-zero rate means submissions are piling up waiting on chain
  confirmation and should be investigated (RPC health, network congestion).

- **`vatix_oracle_submission_confirmation_latency_ms`** (Histogram, #996):
  Time between a resolution tx being broadcast (`broadcast_at`) and its
  confirmation being observed on-chain (`confirmed_at`). Both metrics are
  registered on the shared Prometheus registry in `src/services/metrics.ts`
  and scraped via the existing `/metrics` endpoint.

### Logging

All events are JSON-structured with:

- `timestamp`: ISO 8601 timestamp
- `level`: debug | info | warn | error
- `message`: Human-readable summary
- `marketId`: Associated market
- `id`: Submission/report ID
- `error`: Error message if failure
- `attempt`: Current attempt number
- `durationMs`: Processing time

Example success log:

```json
{
  "ts": "2024-06-16T12:34:56.789Z",
  "level": "info",
  "message": "Oracle submission processed successfully",
  "id": "sub-123",
  "marketId": "market-1",
  "attempt": 1
}
```

Example failure log:

```json
{
  "ts": "2024-06-16T12:35:00.123Z",
  "level": "warn",
  "message": "Oracle submission processing failed, will retry",
  "id": "sub-123",
  "marketId": "market-1",
  "attempt": 1,
  "maxAttempts": 3,
  "error": "Network timeout"
}
```

## Runbook: On-Call Troubleshooting

### Worker Not Processing Submissions

1. **Check worker process**: `ps aux | grep oracle`
   - If dead, restart: `pnpm workers:oracle:start`

2. **Check Redis connection**:

   ```bash
   redis-cli -u $REDIS_URL ping
   # Should return: PONG
   ```

3. **Check queue depth**:

   ```bash
   redis-cli -u $REDIS_URL LLEN oracle-submissions
   # Should show number of pending jobs
   
   # Or via redis-cli with BullMQ key pattern:
   redis-cli KEYS "oracle-submissions:*" | wc -l
   ```

4. **Check worker status and failed jobs**:

   ```bash
   # List failed jobs
   redis-cli LRANGE oracle-submissions:failed 0 -1
   
   # Count completed jobs
   redis-cli LLEN oracle-submissions:completed
   ```

5. **Check logs**: `docker logs <oracle-worker-container>`

### Stuck Submissions (Failed Retries)

If a submission exceeds max retries (3):

1. **View failed jobs** (in DLQ):

   ```bash
   redis-cli LRANGE oracle-submissions:failed 0 9
   # Shows the most recent 10 failed jobs
   ```

2. **Inspect a specific failed job**:

   ```bash
   # Get job details
   redis-cli HGETALL "{jobId}"
   # where jobId is from the failed list above
   ```

3. **Retry a failed job** (manual recovery):

   ```bash
   # Remove from failed list and re-add to queue
   # (Requires BullMQ programmatic access or manual DB fix)
   ```

### Database Out of Sync with BullMQ

If OracleReport records exist but submissions aren't being processed:

1. **Check if queue is empty but jobs are in DLQ**:

   ```bash
   redis-cli LLEN oracle-submissions
   # If 0, check:
   redis-cli LLEN oracle-submissions:failed
   # Count of failed jobs
   ```

2. **Force re-enqueue** (via application code or script):

   ```bash
   # Requires programmatic access to create a new SubmissionQueueItem
   # and call BullMQSubmissionQueue.enqueue()
   ```

3. **Clear DLQ** (after investigation):

   ```bash
   redis-cli DEL oracle-submissions:failed
   # WARNING: Irreversible — only after confirming with on-call lead
   ```

## Testing

### Unit Tests

```bash
# Run all oracle tests
pnpm test -- apps/workers/src/oracle/

# Run specific test file
pnpm test -- redis-submission-queue.test.ts

# With coverage
pnpm test:coverage
```

### Integration Tests

```bash
# Run integration tests (requires Redis + PostgreSQL)
pnpm test:integration

# With detailed output
pnpm test:integration -- --reporter=verbose
```

### Manual Testing

1. **Start redis and PostgreSQL**:

   ```bash
   docker-compose up postgres redis
   ```

2. **Run migrations**:

   ```bash
   pnpm prisma:migrate
   ```

3. **Start oracle worker**:

   ```bash
   ORACLE_SUBMISSION_LOG_LEVEL=debug pnpm workers:oracle:dev
   ```

4. **Trigger resolution** (via API or direct call to OracleService)

5. **Check Redis queue**:

   ```bash
   redis-cli -u $REDIS_URL XLEN oracle:submissions
   redis-cli -u $REDIS_URL XRANGE oracle:submissions - +
   ```

6. **Monitor logs** for enqueue/dequeue events

## Future Enhancements

- [ ] Implement Stellar SDK integration for actual on-chain submission
- [ ] Add batch submission (multiple resolutions in one transaction)
- [ ] Implement circuit breaker for Stellar RPC failures
- [ ] Add metrics export (Prometheus/Grafana)
- [ ] Support for multiple oracle signers (threshold signatures)
- [ ] On-chain transaction receipt tracking and verification
