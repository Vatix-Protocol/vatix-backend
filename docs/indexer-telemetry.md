# Indexer Telemetry

`apps/indexer/src/metrics.ts` (`InternalIndexerMetricsService`) tracks
in-process indexer health metrics that are surfaced via heartbeat logs and
can be scraped/exported for dashboards.

## `events_skipped_unknown_topic_total`

Previously, raw chain events whose topic didn't match any known handler
were dropped with no counter and no dashboard signal — a silent skip that
could hide a lost trade, resolution, or admin action behind what otherwise
looked like healthy ingestion.

`InternalIndexerMetricsService.incrementEventsSkippedUnknownTopic(topic, requestId?)`
now:

- Increments a running total (`eventsSkippedUnknownTopicTotal`).
- Tracks a per-topic breakdown (`eventsSkippedUnknownTopicByTopic`), so
  operators can tell "a new event kind was added on-chain" apart from
  "one topic is spiking."
- Returns a structured log payload
  (`event: "indexer.events.skipped_unknown_topic"`) including the topic
  name and an optional correlation `requestId` (see
  `docs/event-fetcher.md` for how `requestId` is generated per fetch) —
  callers should log this payload immediately at the point of the skip.
  The payload never includes event value/topic XDR bytes or secrets, only
  the topic identifier.

Both the running total and the per-topic breakdown are available via
`getSnapshot()` and the total is included in `toLogFields()`, which the
indexer heartbeat log already emits every 60s (see
`apps/indexer/src/ingestion.ts`).

## Wiring this into a dashboard

Any process that consumes indexer heartbeat logs or scrapes
`getSnapshot()` should treat a non-zero, growing
`eventsSkippedUnknownTopicTotal` as an alertable condition — it means the
on-chain contract is emitting event topics the indexer does not
recognize, which historically has been the root cause of "trades went
missing" incidents. Alert on the rate of increase, not just a static
threshold, since a one-time bump after a contract upgrade (new topic
added, indexer not yet updated to handle it) is expected and should be
resolved by a code change rather than suppressed.

## Production vs. development

This is a pure in-memory counter with no I/O, so there is no
production/dev split to fail-fast on. The counter resets on process
restart; long-running trend analysis should be done downstream (e.g. in
whatever metrics backend scrapes `getSnapshot()`), not by relying on
in-process state surviving restarts.

## Testing

`apps/indexer/src/metrics.test.ts` covers: zero-state, per-topic and
total increments, the structured log payload shape (including
correlation id), and that this counter is independent of
`latestIndexedLedgerSequence`. Run via:

```
pnpm test
```
