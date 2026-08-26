# Admission Control & Load Shedding Runbook

## Overview

Admission control automatically sheds order traffic (returns 503) when settlement queue lag or outbox depth exceeds SLO thresholds. This prevents unbounded accept-during-lag from creating an irreparable operational backlog.

## Configuration

### Environment Variables

```bash
# High water mark: lag threshold to enter shedding (default: 1000 jobs)
SETTLEMENT_LAG_SHED_THRESHOLD=1000

# Low water mark: lag threshold to exit shedding (default: 500 jobs)
# Hysteresis prevents flapping between states
SETTLEMENT_LAG_RECOVERY_THRESHOLD=500

# Redis key prefix (default: "vatix:")
REDIS_KEY_PREFIX=vatix:
```

### Lag Calculation

Total lag = (settlement_queue_depth × 1.0) + (outbox_unpublished_count × 0.5)

- Settlement queue depth has weight 1.0 (critical path)
- Outbox unpublished count has weight 0.5 (secondary)

## Monitoring

### Metrics Exported

The following metrics are exposed at `/metrics` for Prometheus scraping:

- **orders_shed_total** — cumulative count of requests rejected with 503
- **current_lag_gauge** — current total lag (settlement queue + outbox weighted)
- **shed_state_gauge** — current state (0 = accepting, 1 = shedding)

### Alert Rules

**Critical**: Set up alerting for sustained shedding:

```yaml
alert: HighSettlementLagBackpressure
expr: shed_state_gauge == 1
for: 5m
annotations:
  summary: "Admission control is shedding traffic"
  runbook: "See docs/ADMISSION_CONTROL_RUNBOOK.md"
```

## Behavior

### Order Submission (POST /v1/orders)

- **Not shedding (lag < low water mark)**: Accept order, process normally
- **Shedding (lag ≥ high water mark)**: Reject with 503, include `Retry-After: 30` header
- **Transition during high lag**: Continue shedding until lag drops below low water mark (hysteresis)
- **Probe error (in production)**: Fail closed — reject with 503 `lag_detector_probe_failed` to avoid silent degradation when health checks are unavailable

### Cancellations (DELETE /v1/orders/:id)

- **Always allowed** — even during shedding
- Helps unwind large positions during backpressure

### Admin Operations (/admin/*)

- **Always allowed** — bypass admission control
- Enables incident response without cluster degradation

## Incident Response

### Detecting the Cause

#### Probe Failure (lag_detector_probe_failed)

If admission control is shedding with error `lag_detector_probe_failed`, the underlying lag detection is unhealthy.

**Likely causes**:

- Redis is unavailable or timing out
- PostgreSQL (for outbox check) is unavailable or slow
- Network partition to the database

**Action**: Check Redis and PostgreSQL connectivity, logs for connection errors, and network status.

**Behavior in production**: Admission control **always sheds traffic** when probes fail — this is intentional fail-closed behavior to prevent silent degradation. Never allow unknown-health-state traffic through.

**Behavior in development/testing**: Non-production environments may allow requests through during probe failures with a warning log, for easier testing. This is safe only because production uses strict fail-closed behavior.

#### High Settlement Queue Depth

Check BullMQ queue depth across all states (wait, delayed, active):

```bash
redis-cli
# Check each queue state
> LLEN vatix:queue:settlement:wait
> ZCARD vatix:queue:settlement:delayed
> ZCARD vatix:queue:settlement:active
```

The admission control lag detector sums all three states to compute settlement queue depth. A high depth indicates jobs are backing up at any stage of processing.

**Common causes**:

- Settlement worker crashed or slow
- Stellar RPC is experiencing latency
- Database is slow or locked
- Jobs are delayed (e.g., exponential backoff after retry)

**Action**: Check settlement worker logs, Stellar network status, database queries. If jobs are stuck in `delayed`, check for repeated failures that are triggering retry backoff.

#### High Outbox Depth

Check database:

```sql
SELECT COUNT(*) FROM outbox_events WHERE published_at IS NULL;
```

**Common causes**:

- Outbox publishing worker is down
- Downstream event consumer (webhook, CDC sink) is backed up
- Network partition to subscriber systems

**Action**: Check outbox publisher worker, network connectivity, subscriber health.

### Raising Thresholds Temporarily

If shedding is causing operational problems but the lag is legitimate (e.g., scheduled backlog):

```bash
# SSH to pod running API
kubectl exec -it <pod> -- /bin/sh

# Inside pod, use redis-cli to update thresholds dynamically
# Note: This requires redeploying or restarting to persist
export SETTLEMENT_LAG_SHED_THRESHOLD=5000
export SETTLEMENT_LAG_RECOVERY_THRESHOLD=2000
```

**Warning**: Temporarily raising thresholds masks the underlying lag and risks creating an unrepairable backlog. Prefer fixing the root cause.

### Manual Reset

If shedding is stuck (stale lag metric):

```bash
# There is no persistent state to reset; shedding is re-evaluated on every request
# If metrics are stale due to connection loss, restart the API service:
kubectl rollout restart deployment/vatix-api
```

## Integration with Queue Backlog Monitoring

This feature complements:

- **#802**: Add redis CLI recipes to queue backlog runbook
- **#738**: Add incident runbook entry for queue backlog

See those issues for additional Redis queue monitoring recipes.

## Testing

### Test with Artificially High Lag

```bash
# Simulate high settlement queue depth by adding delayed jobs
# This populates the BullMQ delayed queue
redis-cli
> ZADD vatix:queue:settlement:delayed 1693478400000 '{"test":"job"}' # repeat 1001+ times to exceed high water mark

# Trigger admission control
curl -X POST http://localhost:3000/v1/orders \
  -H "Content-Type: application/json" \
  -d '{"marketId":"...", ...}'

# Should return 503 with matching_backpressured error
```

### Verify Recovery

```bash
# Clear settlement queue (all states)
redis-cli
> DEL vatix:queue:settlement:wait vatix:queue:settlement:delayed vatix:queue:settlement:active

# Retry order submission
curl -X POST http://localhost:3000/v1/orders \
  -H "Content-Type: application/json" \
  -d '{"marketId":"...", ...}'

# Should return 200 or normal error (not 503)
```

## Relationship to Outbox Durability

Admission control works together with transactional outbox (#864):

1. Order match is committed atomically with outbox entry
2. Outbox publisher drains entries asynchronously
3. If outbox builds up (lag), admission control sheds new orders
4. This prevents: matches accepted → trades table updated → but settlement not published

Without this load shedding, a slow publisher would cause the outbox to grow unbounded while trades pile up, making recovery difficult.

## Troubleshooting

### Shedding persists but queue is empty

Check if metrics are stale by verifying all three BullMQ queue states:

```bash
redis-cli
> LLEN vatix:queue:settlement:wait
0
> ZCARD vatix:queue:settlement:delayed
0
> ZCARD vatix:queue:settlement:active
0
```

**Solution**: The shedding state is recomputed on every request. If metrics appear stale, restart the API pod.

### Cancellations are also rejected

Cancellations should always be allowed. If they are rejected with 503, check:

1. Request URL contains `/cancel` or is `DELETE /orders/:id`
2. Verify middleware is in correct order (should run before route handlers)

If cancellations are still rejected, this is a bug — report it.

### Threshold tuning

Start with defaults:

- High: 1000 (settlement queue depth)
- Low: 500

If experiencing frequent flapping, widen hysteresis:

- High: 2000
- Low: 500 (now farther from high)

If orders are shed too early or late, adjust based on your SLA and deployment size.
