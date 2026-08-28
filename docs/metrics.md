# Prometheus Metrics (#745, #746)

The API process exposes a Prometheus scrape endpoint alongside the existing
JSON structured-log metrics (see [Indexer Metrics Log](metrics-log.md)).

## Endpoint

```
GET /metrics
```

- Unversioned (not under `/v1`), matching Prometheus/Grafana convention.
- Unauthenticated by convention — restrict network access to it at the
  infra/ingress layer (e.g. only allow the internal Prometheus scraper).
- Excluded from the global rate limiter, like `/v1/health` and `/v1/ready` —
  scrapers poll on a fixed short interval and must never be throttled.
- Returns the Prometheus text exposition format (`Content-Type: text/plain; ...`).

## Source

- `src/services/metrics.ts` — the shared `Registry` (`metricsRegistry`).
  Default Node.js process/runtime metrics (CPU, memory, event loop, GC) are
  collected automatically via `prom-client`'s `collectDefaultMetrics()`, all
  prefixed `vatix_`.
- `src/api/routes/metrics.ts` — the Fastify route that serves the registry.

## Metrics

| Metric                                                        | Type      | Description                                                                                                       |
| ------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------- |
| `vatix_process_*`, `vatix_nodejs_*`                           | various   | Default Node.js process/runtime metrics from `prom-client`.                                                       |
| `vatix_orderbook_hydrated_markets`                            | gauge     | Number of `(market, outcome)` order books currently held in memory by the matching engine (#746).                 |
| `vatix_matching_leader`                                       | gauge     | Whether this process currently holds the matching leader lease: `1` while held, `0` otherwise.                    |
| `vatix_matching_lease_renew_failures_total`                   | counter   | Total failed matching leader lease acquire/renew attempts on this process.                                        |
| `vatix_oracle_fail_closed_total`                              | counter   | Total times the oracle failed closed after all providers were unreachable (no report submitted on-chain).         |
| `vatix_oracle_submission_ambiguous_total`                     | counter   | Total oracle on-chain submissions left in an ambiguous confirmation state (e.g. NOT_FOUND that may still confirm).|
| `vatix_oracle_submission_confirmation_latency_ms`             | histogram | Milliseconds from oracle submission broadcast to on-chain confirmation.                                           |
| `vatix_settlement_outbox_depth`                               | gauge     | Number of settlement outbox rows not yet PUBLISHED (PENDING + FAILED).                                            |
| `vatix_settlement_outbox_lag_seconds`                         | gauge     | Age in seconds of the oldest unpublished settlement outbox row.                                                   |
| `vatix_settlement_outbox_publish_failures_total`              | counter   | Total failed attempts to publish an outbox row to the settlement queue.                                           |
| `vatix_settlement_outbox_orphaned_trades`                     | gauge     | Outbox rows that have failed to publish at least `OUTBOX_ORPHAN_ATTEMPTS_THRESHOLD` times (stalled settlement).   |
| `vatix_settlement_outbox_quarantined_entries`                 | gauge     | Number of outbox entries currently in QUARANTINED status.                                                         |
| `vatix_settlement_outbox_quarantine_transitions_total`        | counter   | Total outbox entries moved to QUARANTINED status due to exceeding retry budget.                                    |

### `vatix_orderbook_hydrated_markets`

Tracks `MatchingService`'s in-memory `books` map size in real time — updated
whenever a book is hydrated (cold-start bulk hydration or lazy per-request
hydration) or invalidated (e.g. on a failed transaction). See
`syncHydratedMarketsGauge()` in `src/matching/matching-service.ts`.

This complements the existing `orderbook.hydrated_markets` structured log
line emitted once at cold start (see [Indexer Metrics Log](metrics-log.md)
for the equivalent indexer pattern) — the gauge reflects the _current_ count
at any point in time, not just the cold-start snapshot.

### `vatix_matching_leader` / `vatix_matching_lease_renew_failures_total`

Single-writer enforcement for the matching engine: exactly one API replica
should report `vatix_matching_leader == 1` at a time (see
[Scaling the API / Matching Leader Lease](deployment-runbook.md#scaling-the-api--matching-leader-lease)
for alerting guidance and failover timing). Updated by
`src/matching/leader-lease.ts` on every acquire, renew, and loss.

### `vatix_oracle_fail_closed_total`

Incremented by `OracleService` whenever every provider (primary + fallback) fails
for a resolution request and the oracle fails closed — i.e. no `OracleReport` is
written and nothing is submitted on-chain. Alert when this counter rises to avoid
silent resolution gaps.

### `vatix_settlement_outbox_*`

The settlement outbox metrics track the transactional outbox pattern used by
`MatchingService.placeOrder` → settlement queue delivery
(see `src/services/outbox-publisher.ts`):

- **`vatix_settlement_outbox_depth`** — total undelivered rows (PENDING + FAILED).
  Should stay near zero under normal operation.
- **`vatix_settlement_outbox_lag_seconds`** — staleness of the oldest undelivered
  row. Alert when this exceeds the acceptable settlement SLA.
- **`vatix_settlement_outbox_orphaned_trades`** — rows stuck past the retry
  threshold (`OUTBOX_ORPHAN_ATTEMPTS_THRESHOLD`). Non-zero means stalled
  settlement that requires operator attention.
- **`vatix_settlement_outbox_quarantined_entries`** — rows moved to QUARANTINED
  after exhausting the retry budget.
- **`vatix_settlement_outbox_quarantine_transitions_total`** — cumulative count
  of entries that entered QUARANTINED status.

## Adding a new metric

1. Define it in `src/services/metrics.ts`, registered against `metricsRegistry`.
2. Update it wherever the underlying state changes.
3. Document it in the table above.
