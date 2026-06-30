# Indexer Event → DB Mapping

Canonical reference for every on-chain contract event: topic discriminator, XDR payload shape, parser, normalized type, and DB destination.

Test vectors: [`apps/indexer/fixtures/contract-event-vectors.json`](../apps/indexer/fixtures/contract-event-vectors.json)

---

## Event table

| Event topic            | Payload shape         | Parser                          | Normalized type                  | DB table(s)                        |
|------------------------|-----------------------|---------------------------------|----------------------------------|------------------------------------|
| `trade_executed`       | ScvMap (9 fields)     | `tradeParser.ts`                | `NormalizedTrade`                | `IndexedTrade`                     |
| `collateral_deposited` | ScvVec 3-tuple        | `collateralDepositedParser.ts`  | `NormalizedCollateralDeposit`    | logged only (no table yet — see §4)|
| `market_resolved`      | ScvVec 3-tuple or ScvMap | `resolutionParser.ts`        | `NormalizedResolution`           | `ResolutionCandidate`              |
| `market_created`       | pre-decoded JS object | `market-created-parser.ts`      | `MarketCreatedEvent`             | ingested outside `PollingIngestionLoop` |

All four events share the same topic encoding: **topic[0] = ScvSymbol** carrying the event name string.

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

**Topic XDR:** `AAAADwAAAA5tYXJrZXRfY3JlYXRlZAAA`

**Parser input:** Pre-decoded `RawMarketCreatedEvent` JS object — not raw XDR. This event is ingested via a path **outside** `PollingIngestionLoop` (e.g. a webhook or separate RPC subscription).

| Field           | Type                        | Notes                                       |
|-----------------|-----------------------------|---------------------------------------------|
| `id`            | `string`                    | Required                                    |
| `question`      | `string`                    | Required, non-empty                         |
| `endTime`       | `number \| string`          | Unix seconds or ISO-8601; normalized to ISO |
| `oracleAddress` | `string`                    | G-prefixed, 56 chars; trimmed               |
| `status`        | `"ACTIVE" \| "RESOLVED" \| "CANCELLED"` | Default `"ACTIVE"`            |

**DB write:** Caller-determined; parser returns `ParseResult<MarketCreatedEvent>` and does not write directly.

---

## Ingestion pipeline

```
Stellar RPC
    │
    ▼
PollingIngestionLoop.ingestFromCursor()
    │
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
             ├── IndexedTrade              (trade_executed)
             ├── ResolutionCandidate       (market_resolved)
             └── logger.debug only         (collateral_deposited — pending table)
```

Events with unrecognised topic symbols are silently skipped by each parser's `isXxxEvent` guard. Parse errors are collected per-event and logged as `warn` without dropping the rest of the batch.
