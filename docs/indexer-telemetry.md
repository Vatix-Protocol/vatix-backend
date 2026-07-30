# Indexer Telemetry: Metrics vs. Traces

The indexer emits two distinct kinds of telemetry via `Telemetry` in
[`apps/indexer/src/telemetry.ts`](../apps/indexer/src/telemetry.ts):

- **Metrics** (`telemetry.record(name, value, tags)`): point-in-time counters
  and gauges (e.g. `indexer.events.fetched`, `indexer.rpc.error`). Use these
  for alerting thresholds and dashboards aggregated over time.
- **Traces** (`telemetry.startSpan(name, tags)` / `span.end(tags)`): duration
  spans around a unit of work. Each ingestion batch tick in
  [`PollingIngestionLoop.ingestFromCursor`](../apps/indexer/src/ingestion.ts)
  emits three spans:
  - `indexer.ingestion.fetch` — time spent fetching the ledger window from RPC.
  - `indexer.ingestion.parse` — time spent parsing fetched events into typed records.
  - `indexer.ingestion.write` — time spent writing the batch via `BatchWriter`.

  Use spans to answer "which stage is slow?" for a given batch; use metrics
  to answer "how many/how often?" across batches over time.

The default `consoleTelemetry` implementation logs both to stdout; swap in
another `Telemetry` implementation to forward to an APM/tracing backend.
