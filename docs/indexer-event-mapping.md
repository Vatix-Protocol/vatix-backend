# Indexer Event → DB Mapping

Canonical reference for every on-chain contract event: topic discriminator, XDR payload shape, parser, normalized type, and DB destination.

Test vectors: [`apps/indexer/fixtures/contract-event-vectors.json`](../apps/indexer/fixtures/contract-event-vectors.json)

---

## Event table

| Event topic               | Payload shape            | Parser                          | Normalized type                  | DB table(s)                        |
|----------------------------|--------------------------|---------------------------------|----------------------------------|------------------------------------|
| `trade_executed_event`     | ScvMap (9 fields)        | `tradeParser.ts`                | `NormalizedTrade`                | `IndexedTrade`                     |
| `collateral_deposited_event` | ScvVec 3-tuple          | `collateralDepositedParser.ts`  | `NormalizedCollateralDeposit`    | logged only (no table yet — see §4)|
| `market_resolved_event`    | topic[1]=u32 market_id, ScvMap{outcome, resolved_at} | `resolutionParser.ts` | `NormalizedResolution`     | `ResolutionCandidate`              |
| `market_created_event`     | topic[1]=u32 market_id, ScvMap{question, end_time} | `marketCreatedParser.ts` | `NormalizedMarketCreated` | `Market` (via `PollingIngestionLoop`) |

All events share the same topic encoding: **topic[0] = ScvSymbol** carrying the event name. Soroban's `#[contractevent]` macro derives that symbol from the event struct name including its literal `Event` suffix (e.g. `MarketCreatedEvent` → `market_created_event`) — see `contracts/market/src/events.rs`.

---

## 1. `trade_executed`

**Topic XDR:** `AAAADwAAAA50cmFkZV9leGVjdXRlZAAA`

**Payload:** ScvMap with keys:

| Key              | ScvType   | Native type | Notes                                    |
|------------------|-----------|-------------|------------------------------------------|
| `market_id`      | ScvSymbol | `string`    |                                          |
| `trader`         | ScvSymbol | `string`    | Stellar account address                  |
| `counterparty`   | ScvSymbol | `string`    | Stellar account address                  |
| `direction`      | ScvSymbol | `string`    | `"buy"` or `"sell"`                      |
| `outcome`        | ScvSymbol | `string`    | `"YES"` or `"NO"`                        |
| `price`          | ScvI128   | `bigint`    | 7 decimal places (5 000 000 = 0.5)       |
| `quantity`       | ScvI128   | `bigint`    | Integer shares                           |
| `buy_order_id`   | ScvSymbol | `string`    |                                          |
| `sell_order_id`  | ScvSymbol | `string`    |                                          |

**DB write:** `IndexedTrade` row via `PrismaBatchWriter`. `priceRaw` and `quantityRaw` stored as `String` (bigint serialized) to avoid precision loss.

---

## 2. `collateral_deposited`

**Payload:** ScvVec — ordered 3-tuple (no keys):

| Index | ScvType  | Native type | DB field     |
|-------|----------|-------------|--------------|
| `[0]` | ScvString | `string`   | `account`    |
| `[1]` | ScvU32    | `number`   | `marketId`   |
| `[2]` | ScvI128   | `bigint`   | `amountRaw`  |

**DB write:** Currently logged via `logger.debug` only — no dedicated table exists yet. A future worker will reconcile collateral deposits into `UserPosition`. The idempotency key is stamped and the event passes through `indexerProcessedEvent` to prevent double-processing once a table is added.

---

## 3. `market_resolved`

**Topic XDR:** `AAAADwAAAA9tYXJrZXRfcmVzb2x2ZWQA`

**Payload — canonical (on-chain tuple):** ScvVec 3-tuple:

| Index | ScvType  | Native type | Notes                                    |
|-------|----------|-------------|------------------------------------------|
| `[0]` | ScvU32   | `number`    | Market identifier, cast to string        |
| `[1]` | ScvBool  | `boolean`   | `true` → `"YES"`, `false` → `"NO"`      |
| `[2]` | ScvU64   | `bigint`    | Unix timestamp of resolution (informational) |

`oracleAddress` is set to `""` for tuple payloads. `batchWriter` substitutes the Stellar null account (`GAAAAAA…AWHF`) when writing to `ResolutionCandidate.operatorAddress`.

**Payload — legacy (ScvMap):** Keys `market_id` (ScvSymbol), `outcome` (ScvSymbol `"YES"`/`"NO"`), `oracle` (ScvSymbol). `oracle` is required on this path; its absence throws `ResolutionParseError`.

**DB write:** `ResolutionCandidate` row with `status = "PROPOSED"`, `source = "chain:market_resolved:{contractId}"`.

---

## 4. `market_created`

**Topic XDR:** `AAAADwAAABRtYXJrZXRfY3JlYXRlZF9ldmVudA==` (`market_created_event`)

**Parser input:** Raw chain event (`RawChainEvent`), parsed by `apps/indexer/src/marketCreatedParser.ts` and run inside `PollingIngestionLoop` alongside the other three event types.

| Source            | ScvType  | Native type | Notes                                              |
|--------------------|----------|-------------|-----------------------------------------------------|
| `topics[1]`         | ScvU32   | `number`    | `market_id`, cast to string                         |
| `value.question`    | ScvString| `string`    | Required, non-empty                                 |
| `value.end_time`    | ScvU64   | `bigint`    | Unix seconds; normalized to ISO-8601                 |

The contract does not publish `oracle_address` or `status` on this event (the oracle pubkey is stored on-chain but not republished here). `oracleAddress` is set to `""` pending reconciliation and `status` defaults to `"ACTIVE"`, matching every market's state immediately after creation.

**DB write:** `Market` row via `PrismaBatchWriter`, same idempotency/cursor path as the other three event kinds.

> `apps/indexer/market-created-parser.ts` (note the hyphenated filename — a separate module) is a lower-level, pre-decoded-object validator (`RawMarketCreatedEvent` → `ParseResult<MarketCreatedEvent>`) intended for a future off-chain/webhook creation path. It is not used by `PollingIngestionLoop` and is unrelated to the on-chain parser described above.

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
             ├── Market                    (market_created_event)
             ├── IndexedTrade              (trade_executed_event)
             ├── ResolutionCandidate       (market_resolved_event)
             └── logger.debug only         (collateral_deposited_event — pending table)
```

Events with unrecognised topic symbols are silently skipped by each parser's `isXxxEvent` guard. Parse errors are collected per-event and logged as `warn` without dropping the rest of the batch.
