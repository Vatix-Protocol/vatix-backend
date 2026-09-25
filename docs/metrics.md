# Prometheus Metrics (#745, #746)

The API process exposes a Prometheus scrape endpoint alongside the existing
JSON structured-log metrics (see [Indexer Metrics Log](metrics-log.md)).

## Endpoint

```
GET /metrics
```

- Unversioned (not under `/v1`), matching Prometheus/Grafana convention.
- **Authorized (#1130).** See [Scrape authz](#scrape-authz-1130) below.
- Excluded from the global rate limiter, like `/v1/health` and `/v1/ready` —
  scrapers poll on a fixed short interval and must never be throttled.
- Returns the Prometheus text exposition format (`Content-Type: text/plain; ...`).

## Scrape authz (#1130)

`/metrics` is deliberately outside the rate limiter and admission control, so
it must not be left open by default. The API resolves a scrape policy once at
boot from the validated env (`src/api/middleware/metricsAuth.ts`):

| Variable                     | Meaning                                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `METRICS_SCRAPE_TOKEN`       | Bearer token required on every scrape (`Authorization: Bearer <token>`). Enforced whenever set.                           |
| `METRICS_SCRAPE_ALLOWED_IPS` | Comma-separated source addresses allowed to scrape: exact IPs and/or IPv4 CIDR ranges (`10.0.0.0/8,192.168.1.10`).        |
| `METRICS_REQUIRE_AUTH`       | Deny-by-default override. Unset = `true` in production, `false` in development/test. `false` in production warns at boot. |

Rules, in order:

1. If `METRICS_SCRAPE_TOKEN` is set, a valid bearer token is required — the IP
   allowlist never substitutes for it (token check runs first, and token
   comparison is constant-time over SHA-256 digests so length/timing leaks
   nothing).
2. Otherwise, if `METRICS_SCRAPE_ALLOWED_IPS` is set, only those source
   addresses are served.
3. Otherwise, requests are denied (`METRICS_AUTH_NOT_CONFIGURED`) whenever authz
   is required. **Production fails to boot** if neither is configured and
   `METRICS_REQUIRE_AUTH` is not explicitly `false`, so an unprotected scrape
   endpoint cannot ship by omission. Development/test keep the historical open
   endpoint.

Denials never return the registry body. They return a stable error code and
increment `vatix_metrics_scrape_rejected_total{reason}`:

| Situation                        | Status | `code`                        | `reason` label        |
| -------------------------------- | ------ | ----------------------------- | --------------------- |
| No `Authorization` header        | 401    | `METRICS_AUTH_MISSING`        | `missing_token`       |
| Wrong / non-bearer token         | 401    | `METRICS_AUTH_INVALID`        | `invalid_token`       |
| Source address outside allowlist | 403    | `METRICS_IP_FORBIDDEN`        | `ip_not_allowed`      |
| No authz configured but required | 403    | `METRICS_AUTH_NOT_CONFIGURED` | `auth_not_configured` |

401 responses carry `WWW-Authenticate: Bearer realm="metrics"`. Alert on any
non-zero rate of `vatix_metrics_scrape_rejected_total` — it is either a
misconfigured scraper (metrics gap) or probing of an internal endpoint.

Prometheus scrape config example:

```yaml
scrape_configs:
  - job_name: vatix-api
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/vatix-metrics-token
    static_configs:
      - targets: ["vatix-api.internal:3000"]
```

**Rollback:** set `METRICS_REQUIRE_AUTH=false` (and/or remove the token) to
restore the previous open behavior without a code revert — do that only when
the endpoint is protected at the ingress layer, and expect a boot-time warning.

## Source

- `src/services/metrics.ts` — the shared `Registry` (`metricsRegistry`).
  Default Node.js process/runtime metrics (CPU, memory, event loop, GC) are
  collected automatically via `prom-client`'s `collectDefaultMetrics()`, all
  prefixed `vatix_`.
- `src/api/routes/metrics.ts` — the Fastify route that serves the registry.
- `src/api/middleware/metricsAuth.ts` — scrape policy resolution and the
  allow/deny decision (`authorizeMetricsScrape`).
- `apps/indexer/src/metrics.ts` — the indexer process's `Registry`
  (`indexerMetricsRegistry`). A separate registry from the API process
  because the indexer may run as an independent service. See `apps/indexer/src/httpServer.ts`
  for the Fastify route that serves it.

## Metrics

### API process

| Metric                                                 | Type      | Description                                                                                                                                                     |
| ------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vatix_process_*`, `vatix_nodejs_*`                    | various   | Default Node.js process/runtime metrics from `prom-client`.                                                                                                     |
| `vatix_orderbook_hydrated_markets`                     | gauge     | Number of `(market, outcome)` order books currently held in memory by the matching engine (#746).                                                               |
| `vatix_matching_leader`                                | gauge     | Whether this process currently holds the matching leader lease: `1` while held, `0` otherwise.                                                                  |
| `vatix_matching_lease_renew_failures_total`            | counter   | Total failed matching leader lease acquire/renew attempts on this process.                                                                                      |
| `vatix_oracle_fail_closed_total`                       | counter   | Total times the oracle failed closed after all providers were unreachable (no report submitted on-chain).                                                       |
| `vatix_oracle_submission_ambiguous_total`              | counter   | Total oracle on-chain submissions left in an ambiguous confirmation state (e.g. NOT_FOUND that may still confirm).                                              |
| `vatix_oracle_submission_confirmation_latency_ms`      | histogram | Milliseconds from oracle submission broadcast to on-chain confirmation.                                                                                         |
| `vatix_settlement_outbox_depth`                        | gauge     | Number of settlement outbox rows not yet PUBLISHED (PENDING + FAILED).                                                                                          |
| `vatix_settlement_outbox_lag_seconds`                  | gauge     | Age in seconds of the oldest unpublished settlement outbox row.                                                                                                 |
| `vatix_settlement_outbox_publish_failures_total`       | counter   | Total failed attempts to publish an outbox row to the settlement queue.                                                                                         |
| `vatix_settlement_outbox_orphaned_trades`              | gauge     | Outbox rows that have failed to publish at least `OUTBOX_ORPHAN_ATTEMPTS_THRESHOLD` times (stalled settlement).                                                 |
| `vatix_settlement_outbox_quarantined_entries`          | gauge     | Number of outbox entries currently in QUARANTINED status.                                                                                                       |
| `vatix_settlement_outbox_quarantine_transitions_total` | counter   | Total outbox entries moved to QUARANTINED status due to exceeding retry budget.                                                                                 |
| `vatix_settlement_lag`                                 | histogram | Distribution of settlement lag scores observed by admission control. Buckets: 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000. Use this for alerting (#981). |
| `vatix_settlement_lag_current`                         | gauge     | Latest instantaneous settlement lag score. Dashboard signal only — alert on the `vatix_settlement_lag` histogram instead (#981).                                |
| `vatix_orders_shed_total`                              | counter   | Total orders shed by admission control due to settlement lag.                                                                                                   |
| `vatix_admission_shedding`                             | gauge     | `1` while admission control is shedding order traffic, `0` otherwise.                                                                                           |
| `vatix_metrics_scrape_rejected_total`                  | counter   | Total `/metrics` scrapes denied by the scrape authz policy, labelled `reason` (#1130). Alert on any non-zero rate.                                              |

### Indexer process

| Metric                                         | Type    | Description                                                                                |
| ---------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `vatix_process_*`, `vatix_nodejs_*`            | various | Default Node.js process/runtime metrics from `prom-client`.                                |
| `vatix_indexer_latest_indexed_ledger_sequence` | gauge   | Latest ledger sequence that has been successfully indexed (#713, #1096).                   |
| `vatix_indexer_latest_network_ledger_sequence` | gauge   | Latest ledger sequence reported by the Stellar network (#713, #1096).                      |
| `vatix_indexer_lag`                            | gauge   | Difference between the latest network ledger and the indexed ledger (#713, #1096).         |
| `vatix_indexer_gap_detected_total`             | counter | Total number of ledger gaps detected since process start (#711, #1096).                    |
| `vatix_indexer_backfill_ledgers_total`         | counter | Total number of ledgers back-filled during gap catch-up since process start (#711, #1096). |
| `vatix_indexer_parse_error_total`              | counter | Total number of event parse errors (all parsers) since process start (#712, #1096).        |

#### `vatix_indexer_latest_indexed_ledger_sequence`

Updated by `InternalIndexerMetricsService.setLatestIndexedLedgerSequence()` in
`apps/indexer/src/metrics.ts`. This is the high-water mark of the ingestion
loop — the ledger sequence up to which events have been fetched, parsed, and
persisted. Used to compute the gauge `vatix_indexer_lag` and to detect
cursor-level gaps via `GapDetector.detectCursorGap()`.

#### `vatix_indexer_latest_network_ledger_sequence`

Updated by `InternalIndexerMetricsService.setLatestNetworkLedgerSequence()`.
Reflects the latest ledger sequence reported by the Stellar RPC/Horizon node.
Used alongside `vatix_indexer_latest_indexed_ledger_sequence` to compute the
indexer lag.

#### `vatix_indexer_lag`

A derived gauge computed as `max(0, network_ledger_sequence - indexed_ledger_sequence)`.
A rising lag indicates the indexer is falling behind the network tip and may
need operator attention. Alert when this value exceeds the ingestion
interval's acceptable drift (typically a few windows).

#### `vatix_indexer_gap_detected_total`

Incremented by `GapDetector.runBackfill()` in `apps/indexer/src/gapDetector.ts`
each time a discontinuous ledger range is detected. A low but non-zero rate is
normal (e.g. after a process restart or a short network blip). A rapidly
rising counter or a persistent non-zero rate warrants investigation.

#### `vatix_indexer_backfill_ledgers_total`

Incremented by the number of ledgers re-fetched during gap catch-up. Each
increment is `gapSize` (the number of ledgers in the detected gap range).
Tracked alongside `vatix_indexer_gap_detected_total` to understand the volume
of catch-up work.

#### `vatix_indexer_parse_error_total`

Incremented by `PollingIngestionLoop.ingestFromCursor()` for each event that
a parser rejects (see `TradeParseError`, `ResolutionParseError`,
`CollateralDepositedParseError`, `MarketCreatedParseError` in
`apps/indexer/src/types.ts`). A non-zero value indicates contract events that
the indexer was unable to decode. Investigate whether the event topic shape
has changed or a new event type has been introduced without a corresponding
parser.

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

### `vatix_settlement_lag` (histogram) vs `vatix_settlement_lag_current` (gauge) — #981

Admission control (`src/api/middleware/admissionControl.ts`) samples a
settlement lag score on each order request and feeds it to
`src/services/lag-metrics.ts`. That score is published **twice, as two metric
types**, because they answer different questions:

- **`vatix_settlement_lag_current`** (gauge) is a single sampled point. It is
  fine on a dashboard graph, but a Grafana alert rule on a raw gauge either
  flaps on brief spikes or misses sustained elevation that happens to fall
  between scrapes. Do not page on it.
- **`vatix_settlement_lag`** (histogram) records the _distribution_ of scores
  over time. Alert on a rolling quantile or average, which is stable under
  scrape jitter:

  ```promql
  # p90 lag over the last 5 minutes exceeds the shed threshold
  histogram_quantile(0.9, sum(rate(vatix_settlement_lag_bucket[5m])) by (le)) > 500

  # moving-average lag over the last 5 minutes
  rate(vatix_settlement_lag_sum[5m]) / rate(vatix_settlement_lag_count[5m])
  ```

Pairing rule of thumb: **gauge for "what is it right now" panels, histogram
for "has it been bad for a while" alerts.**

## Adding a new metric

1. Define it in the relevant `metrics.ts` file (API: `src/services/metrics.ts`,
   indexer: `apps/indexer/src/metrics.ts`), registered against the appropriate
   registry.
2. Update it wherever the underlying state changes.
3. Document it in the table above.
