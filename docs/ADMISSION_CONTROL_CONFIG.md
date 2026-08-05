# Admission Control Configuration

## Overview

Admission control provides load shedding for the orders API based on downstream settlement lag. When lag exceeds a threshold, new orders are rejected with 503 Service Unavailable to prevent backlog buildup.

## Environment Variables

| Variable                            | Default | Description                                           | Impact            |
| ----------------------------------- | ------- | ----------------------------------------------------- | ----------------- |
| `SETTLEMENT_LAG_SHED_THRESHOLD`     | `1000`  | High water mark: start shedding when lag ≥ this value | Production tuning |
| `SETTLEMENT_LAG_RECOVERY_THRESHOLD` | `500`   | Low water mark: stop shedding when lag ≤ this value   | Hysteresis width  |

## How Lag is Measured

Total lag is computed as a weighted sum:

```
total_lag = (settlement_queue_depth × 1.0) + (outbox_unpublished_count × 0.5)
```

**Settlement Queue Depth**

- Read from Redis stream (`XLEN`) or BullMQ queue (`ZCARD`)
- Represents pending settlement jobs in `vatix:queue:settlement`
- Weight: 1.0 (critical path)

**Outbox Unpublished Count**

- Counted from database table (`outbox_events` WHERE `published_at IS NULL`)
- Represents uncommitted/undelivered state changes
- Weight: 0.5 (secondary; may not exist initially)

## State Machine

```
       lag < low_water                lag >= high_water
           ┌─────────────────────────────────────┐
           │                                     │
           ▼                                     ▼
        ACCEPTING      ──────────────▶    SHEDDING
        (lag < 500)      high_water    (lag >= 1000)
                         lag >= 1000
           ▲                                     │
           │                                     │
           └─────────────────────────────────────┘
                  low_water_lag <= 500
```

### Hysteresis

- **Entry**: `lag >= SETTLEMENT_LAG_SHED_THRESHOLD` (high water mark)
- **Exit**: `lag <= SETTLEMENT_LAG_RECOVERY_THRESHOLD` (low water mark)
- **Purpose**: Prevent rapid state flapping when lag hovers near a single threshold

## Response Format

When shedding, rejected orders receive:

```json
{
  "error": "matching_backpressured",
  "message": "Service is experiencing high settlement lag. Please retry after a short delay.",
  "details": {
    "settlementQueueDepth": 1500,
    "outboxUnpublishedCount": 300,
    "totalLag": 1650
  },
  "retryAfterSeconds": 30
}
```

HTTP Status: `503 Service Unavailable`
Header: `Retry-After: 30`

## Exceptions

Requests that **bypass** admission control:

1. **Order Cancellations**: `DELETE /v1/orders/:id` or `POST /v1/orders/:id/cancel`
   - Reason: Must be processable even under backpressure to unwind positions
2. **Admin Operations**: Any `POST /admin/*`, `PATCH /admin/*`, `DELETE /admin/*`
   - Reason: Incident response takes priority
3. **Health Checks**: `/v1/health`, `/v1/ready`, `/metrics`
   - Reason: K8s liveness/readiness probes must not be gated

## Tuning

### Default Configuration

Assumes:

- Settlement worker processes ~100 jobs/second
- Reasonable SLA: queue drain in ~10 seconds at high threshold

```
SETTLEMENT_LAG_SHED_THRESHOLD=1000   # ~10s of backlog
SETTLEMENT_LAG_RECOVERY_THRESHOLD=500 # ~5s
```

### For Smaller Deployments

If settlement is much faster (> 500 jobs/s):

```
SETTLEMENT_LAG_SHED_THRESHOLD=500
SETTLEMENT_LAG_RECOVERY_THRESHOLD=250
```

### For Larger Deployments

If you have sustained high load:

```
SETTLEMENT_LAG_SHED_THRESHOLD=5000
SETTLEMENT_LAG_RECOVERY_THRESHOLD=2000
```

### For Bursty Patterns

If load is spiky but drains quickly (don't want false positives):

```
SETTLEMENT_LAG_SHED_THRESHOLD=3000
SETTLEMENT_LAG_RECOVERY_THRESHOLD=1000  # Wider hysteresis
```

## Metrics

Exported at `/metrics` for Prometheus:

```
# HELP orders_shed_total Total orders rejected due to backpressure
# TYPE orders_shed_total counter
orders_shed_total 42

# HELP current_lag_gauge Current settlement lag (weighted sum)
# TYPE current_lag_gauge gauge
current_lag_gauge 750

# HELP shed_state_gauge Current shedding state (0=accepting, 1=shedding)
# TYPE shed_state_gauge gauge
shed_state_gauge 0
```

## Interaction with Rate Limiting

Admission control and rate limiting work independently:

- **Rate Limiting** (#799): Caps request rate per user/IP
- **Admission Control** (#881): Sheds traffic based on downstream health

If both are active, the one that rejects first wins. Example:

```
User hits rate limit → 429 Too Many Requests
(regardless of lag)

User within rate limit but lag high → 503 Service Unavailable
```

## Future Enhancements

- **Per-Market Shedding**: Shed only for markets with high lag
- **Adaptive Thresholds**: Auto-tune based on settlement latency SLO
- **Gradual Backoff**: Return 503 to X% of requests instead of all-or-nothing
