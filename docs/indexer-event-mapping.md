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

**DB write:** `IndexedTrade` row via `PrismaBatchWriter`. `priceRaw` and `quantityRaw` stored as `String` (bigint serialized) to avoid precision loss. `PrismaBatchWriter` also reconciles the trade into both parties' `UserPosition.yesShares`/`noShares` (`Int` columns) — since `quantity` is already whole integer shares (no fixed-point scale, unlike `price`/collateral), this conversion is a validated bigint→Number bounds check rather than a division; see `sharesRawToInt` in [Decimal/share conversion utilities](#decimalshare-conversion-utilities) below.

**Order id join validation:** `buy_order_id`/`sell_order_id` must resolve to a real `Order.id` (a `uuid()` per `prisma/schema.prisma`). `tradeParser.ts` always rejects an empty order id, and in `NODE_ENV=production` additionally rejects any value that isn't UUID-shaped — this is a dev-fixture allowance only, since non-UUID ids (e.g. legacy fixtures like `"buy-1"`) can never join to a CLOB `Order` row. A production rejection increments `indexer.parser.unjoinable_order_id` (tags: `parser`, `eventId`, `contractId`, `ledger`).

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

**Production vs. local stubs:** Both legacy shapes (ScvVec tuple and legacy ScvMap) exist only to decode local devnet/test fixtures and are rejected with a `ResolutionParseError` when `NODE_ENV=production` (or the `nodeEnv` option passed to `parseResolutionEvent`/`parseResolutionEvents` is `"production"`). Only the canonical on-chain shape (`topics[1]=market_id`, value `{outcome, resolved_at}`) is accepted in production. A rejection in production increments `indexer.parser.legacy_shape_rejected` (tags: `parser`, `eventId`, `contractId`, `ledger`) so operators can see a contract/topic regression instead of silently getting `ResolutionCandidate` rows with a blank `oracleAddress`.

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

### Concurrent batch writers (#946)

Horizon delivery is at-least-once, and more than one indexer process (or an
overlapping retry of the same instance) can end up processing the same
ledger range at the same time. When two writers race to insert the same
idempotency key, Postgres's unique constraint lets exactly one `create()`
win; the loser gets a `P2002` unique-violation, which aborts that writer's
transaction. `PrismaBatchWriter` treats `P2002` as a retryable condition
(same bounded backoff as connection/serialization errors — up to 3 retries):
the retried transaction re-reads `IndexerProcessedEvent`, now sees the
row the other writer committed, and correctly classifies it as a duplicate
instead of writing a second row or crashing the batch. Every other record
in that batch (genuinely new events sharing the transaction) is retried and
committed normally. See the "concurrent batch writers" tests in
`apps/indexer/src/batchWriter.test.ts`.

## Decimal/share conversion utilities

`apps/indexer/src/decimalUtils.ts` centralizes every raw-on-chain-integer ↔
JS-value conversion instead of call sites hand-rolling scale math:

| Function             | Direction                                        | Scale                                                                                              |
| -------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `amountRawToDecimal` | raw i128 (bigint/string) → `Decimal(20,8)`       | ÷ 10^7 (7 implicit decimals — collateral/price)                                                    |
| `decimalToAmountRaw` | `Decimal(20,8)` → raw i128 (bigint)              | × 10^7, inverse of the above                                                                       |
| `sharesRawToInt`     | raw i128 (bigint/string) → validated JS `number` | none — on-chain share quantities are already whole integers (see the `quantity` field table above) |

All three throw `RangeError` on out-of-range/malformed input rather than
silently truncating or losing precision (e.g. `sharesRawToInt` rejects a
quantity past `Number.MAX_SAFE_INTEGER` instead of letting a bare
`Number(bigint)` round it).

**On contract test vectors (#948):** `vatix-contract/test-vectors/share-math.json`
— the on-chain contract's own share-math fixtures — is not vendored into
this repository, so these utilities cannot be checked against the
contract's literal test vectors today. `decimalUtils.test.ts` instead fuzzes
the documented invariants (round-trip losslessness, exact boundaries) with a
seeded PRNG for reproducibility. If the contract fixtures become available,
load `share-math.json` in that test file alongside — not instead of — the
fuzz coverage.
