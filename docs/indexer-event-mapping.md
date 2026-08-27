# Indexer Event → DB Mapping

Canonical reference for every on-chain contract event: topic discriminator, XDR payload shape, parser, normalized type, and DB destination.

Test vectors: [`apps/indexer/fixtures/contract-event-vectors.json`](../apps/indexer/fixtures/contract-event-vectors.json)

---

## Event table

| Event topic            | Payload shape            | Parser                         | Normalized type               | DB table(s)           |
| ---------------------- | ------------------------ | ------------------------------ | ----------------------------- | --------------------- |
| `trade_executed`       | ScvMap (9 fields)        | `tradeParser.ts`               | `NormalizedTrade`             | `IndexedTrade`        |
| `collateral_deposited` | ScvVec 3-tuple           | `collateralDepositedParser.ts` | `NormalizedCollateralDeposit` | `CollateralDeposit`   |
| `market_resolved`      | ScvVec 3-tuple or ScvMap | `resolutionParser.ts`          | `NormalizedResolution`        | `ResolutionCandidate` |
| `market_created`       | ScvMap (topic + value)   | `marketCreatedParser.ts`       | `NormalizedMarketCreated`     | `Market`              |

All events share the same topic encoding: **topic[0] = ScvSymbol** carrying the event name. Soroban's `#[contractevent]` macro derives that symbol from the event struct name including its literal `Event` suffix (e.g. `MarketCreatedEvent` → `market_created_event`) — see `contracts/market/src/events.rs`.

## Unknown/unrecognized topics

When a parser encounters an event with a topic symbol it does not recognize, it increments the metric `indexer.parser.unknown_topics` with tags including `parser` (parser name), `eventId` (the event ID), `contractId` (contract address), and `ledger` (ledger sequence). This metric signals that a new on-chain event type needs a parser, and allows operators to diagnose missing coverage without reading raw ledger data.

---

## 1. `trade_executed`

**Topic XDR:** `AAAADwAAABR0cmFkZV9leGVjdXRlZF9ldmVudA==` (`trade_executed_event`)

> The contract does not yet publish this event — trades are currently matched off-chain by the CLOB (see the `Trade`/`IndexedTrade` Prisma models). `tradeParser.ts` anticipates the eventual on-chain event using the same topic-naming convention every other event in `contracts/market/src/events.rs` follows: Soroban's `#[contractevent]` macro snake-cases the struct name including its `Event` suffix (e.g. `MarketCreatedEvent` → `market_created_event`).

**Payload:** ScvMap with keys:

| Key             | ScvType   | Native type | Notes                              |
| --------------- | --------- | ----------- | ---------------------------------- |
| `market_id`     | ScvSymbol | `string`    |                                    |
| `trader`        | ScvSymbol | `string`    | Stellar account address            |
| `counterparty`  | ScvSymbol | `string`    | Stellar account address            |
| `direction`     | ScvSymbol | `string`    | `"buy"` or `"sell"`                |
| `outcome`       | ScvSymbol | `string`    | `"YES"` or `"NO"`                  |
| `price`         | ScvI128   | `bigint`    | 7 decimal places (5 000 000 = 0.5) |
| `quantity`      | ScvI128   | `bigint`    | Integer shares                     |
| `buy_order_id`  | ScvSymbol | `string`    |                                    |
| `sell_order_id` | ScvSymbol | `string`    |                                    |

**DB write:** `IndexedTrade` row via `PrismaBatchWriter`. `priceRaw` and `quantityRaw` stored as `String` (bigint serialized) to avoid precision loss.

---

## 2. `collateral_deposited`

**Payload:** ScvVec — ordered 3-tuple (no keys):

| Index | ScvType   | Native type | DB field    |
| ----- | --------- | ----------- | ----------- |
| `[0]` | ScvString | `string`    | `account`   |
| `[1]` | ScvU32    | `number`    | `marketId`  |
| `[2]` | ScvI128   | `bigint`    | `amountRaw` |

**DB write:** `CollateralDeposit` row via `PrismaBatchWriter`. `amountRaw` is stored as `String` (bigint serialized) to avoid precision loss, matching `IndexedTrade.priceRaw`/`quantityRaw`. Position accounting against `UserPosition` is handled separately by a worker — `batchWriter` only persists the raw deposit for audit/reconciliation.

---

## 3. `market_resolved`

**Topic XDR:** `AAAADwAAABVtYXJrZXRfcmVzb2x2ZWRfZXZlbnQAAAA=` (`market_resolved_event`)

**Payload — real on-chain shape:** `MarketResolvedEvent` (`contracts/market/src/events.rs`) publishes `market_id` as `topics[1]` and `{ outcome, resolved_at }` as the value:

| Index | ScvType | Native type | Notes                                        |
| ----- | ------- | ----------- | -------------------------------------------- |
| `[0]` | ScvU32  | `number`    | Market identifier, cast to string            |
| `[1]` | ScvBool | `boolean`   | `true` → `"YES"`, `false` → `"NO"`           |
| `[2]` | ScvU64  | `bigint`    | Unix timestamp of resolution (informational) |

The contract does not publish an oracle address on this event, so `oracleAddress` is `""`. `batchWriter` substitutes the Stellar null account (`GAAAAAA…AWHF`) when writing to `ResolutionCandidate.operatorAddress`.

**Payload — legacy ScvVec 3-tuple:** `[market_id: u32, outcome: bool, resolved_at: u64]` all inside the value (no second topic). Same field semantics as above; `oracleAddress` is also `""`.

**Payload — legacy ScvMap:** Keys `market_id` (ScvSymbol), `outcome` (ScvSymbol `"YES"`/`"NO"`), `oracle` (ScvSymbol), all inside the value. `oracle` is required on this path; its absence throws `ResolutionParseError`.

**DB write:** `ResolutionCandidate` row with `status = "PROPOSED"`, `source = "chain:market_resolved:{contractId}"`.

---

## 4. `market_created`

**Topic XDR:** `AAAADwAAABRtYXJrZXRfY3JlYXRlZF9ldmVudA==` (`market_created_event`)

**Parser input:** Raw chain event (`RawChainEvent`), parsed by `apps/indexer/src/marketCreatedParser.ts` and run inside `PollingIngestionLoop.ingestFromCursor()` alongside the other three event types — `parseMarketCreatedEvents()` normalizes each matching event into a `NormalizedMarketCreated`, exactly like `parseTradeEvents()`, `parseResolutionEvents()`, and `parseCollateralDepositedEvents()`.

| Field           | Type                                    | Notes                                                                         |
| --------------- | --------------------------------------- | ----------------------------------------------------------------------------- |
| `eventId`       | `string`                                | Stellar event id — `{ledger}-{txIndex}-{eventIndex}`                          |
| `marketId`      | `string`                                | On-chain market identifier, used as `Market.id`                               |
| `question`      | `string`                                | Decoded from the event value `ScvMap`                                         |
| `endTime`       | `string`                                | Unix seconds or ISO-8601 input; normalized to ISO                             |
| `oracleAddress` | `string`                                | Not published by the contract on this event; left `""` pending reconciliation |
| `status`        | `"ACTIVE" \| "RESOLVED" \| "CANCELLED"` | Always `"ACTIVE"` for a freshly created market                                |

**DB write:** `Market` row via `PrismaBatchWriter`, `upsert`-ed on `id` (create on first sight, update on replay — e.g. a status change). Like every other event kind, the normalized record is stamped with an idempotency key via `withIdempotencyKey()` before being handed to `PrismaBatchWriter.write()` — see [Idempotency key format](#idempotency-key-format) below.

`apps/indexer/market-created-parser.ts` (no `src/` prefix) is an unused legacy parser kept only for its own test; it is not wired into `PollingIngestionLoop` or any other ingestion path.

---

## Ingestion pipeline

```
Stellar RPC
    │
    ▼
PollingIngestionLoop.ingestFromCursor()
    │
    ├── parseMarketCreatedEvents()     → NormalizedMarketCreated[]
    ├── parseTradeEvents()            → NormalizedTrade[]
    ├── parseResolutionEvents()       → NormalizedResolution[]
    └── parseCollateralDepositedEvents() → NormalizedCollateralDeposit[]
             │
             ▼
        withIdempotencyKey()   (SHA-256 of contractId:ledger:txIndex:eventIndex)
             │
             ▼
        PrismaBatchWriter.write()
             │
             ├── Market.upsert()           (market_created_event)
             ├── IndexedTrade              (trade_executed_event)
             ├── ResolutionCandidate       (market_resolved)
             └── CollateralDeposit         (collateral_deposited)
```

Events with unrecognised topic symbols are silently skipped by each parser's `isXxxEvent` guard. Parse errors are collected per-event and logged as `warn` without dropping the rest of the batch.

---

## Idempotency key format

Every normalized record — trade, resolution, collateral deposit, and market-created alike — is stamped with an idempotency key by `withIdempotencyKey()` (`apps/indexer/src/idempotency.ts`) before it reaches `PrismaBatchWriter.write()`:

```
key = SHA256(`${contractId}:${ledger}:${txIndex}:${eventIndex}`)
```

`ledger`, `txIndex`, and `eventIndex` are parsed from the Stellar event id (`{ledger}-{txIndex}-{eventIndex}`, e.g. `0000000042-0000000001-0000000003`), the same id every event kind — including `market_created` — carries. `PrismaBatchWriter` uses this key as the unique constraint on `IndexerProcessedEvent`, so a duplicate or retried delivery of the same event (same ledger, tx, and event position) is skipped as a no-op instead of writing a second row — e.g. a second `Market` for a replayed `market_created` event. See `apps/indexer/src/idempotency.test.ts` and `apps/indexer/src/batchWriter.test.ts` for the duplicate-delivery test coverage.
