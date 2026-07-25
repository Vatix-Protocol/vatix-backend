# Database Schema

The database schema is defined in [`prisma/schema.prisma`](../prisma/schema.prisma) and managed via Prisma Migrate.

See [docs/migrations.md](migrations.md) for migration commands and workflow.

## Enums

| Enum                        | Values                                                   |
| --------------------------- | -------------------------------------------------------- |
| `MarketStatus`              | `ACTIVE`, `RESOLVED`, `CANCELLED`                        |
| `OrderSide`                 | `BUY`, `SELL`                                            |
| `OrderStatus`               | `OPEN`, `FILLED`, `CANCELLED`, `PARTIALLY_FILLED`        |
| `Outcome`                   | `YES`, `NO`                                              |
| `ResolutionCandidateStatus` | `PROPOSED`, `CHALLENGED`, `ACCEPTED`, `REJECTED`         |
| `ResolutionStatus`          | `ACTIVE`, `CORRECTED`, `OVERRIDDEN`                      |
| `OracleSource`              | `CHAINLINK`, `PYTH`, `UMA`, `API3`, `INTERNAL`, `MANUAL` |

## Models

### `Market`

Represents a prediction market.

| Column            | Type           | Notes                                           |
| ----------------- | -------------- | ----------------------------------------------- |
| `id`              | `uuid`         | Primary key                                     |
| `question`        | `String`       | Market question text                            |
| `end_time`        | `DateTime`     | When the market closes for trading              |
| `resolution_time` | `DateTime?`    | When the market was resolved                    |
| `oracle_address`  | `VarChar(56)`  | Stellar oracle address                          |
| `status`          | `MarketStatus` | Default `ACTIVE`                                |
| `outcome`         | `Boolean?`     | `true` = YES, `false` = NO, `null` = unresolved |
| `created_at`      | `DateTime`     | Auto-set on insert                              |
| `updated_at`      | `DateTime`     | Auto-updated                                    |

Indexes: `status`, `end_time`, `(status, end_time)`, `(status, created_at DESC)`

### `Order`

A buy or sell order placed by a user on a market.

| Column            | Type            | Notes                              |
| ----------------- | --------------- | ---------------------------------- |
| `id`              | `uuid`          | Primary key                        |
| `market_id`       | `uuid`          | FK → `markets.id` (cascade delete) |
| `user_address`    | `VarChar(56)`   | Stellar wallet address             |
| `side`            | `OrderSide`     | `BUY` or `SELL`                    |
| `outcome`         | `Outcome`       | `YES` or `NO`                      |
| `price`           | `Decimal(10,8)` | Limit price                        |
| `quantity`        | `Int`           | Total order quantity               |
| `filled_quantity` | `Int`           | Quantity filled so far             |
| `status`          | `OrderStatus`   | Default `OPEN`                     |
| `created_at`      | `DateTime`      | Auto-set on insert                 |

### `OracleReport`

A raw report submitted by an oracle provider.

| Column                 | Type           | Notes                                  |
| ---------------------- | -------------- | -------------------------------------- |
| `id`                   | `uuid`         | Primary key                            |
| `source`               | `VarChar(256)` | Provider identifier                    |
| `payload_hash`         | `VarChar(64)`  | Hash of the submitted payload          |
| `confidence`           | `Decimal(5,4)` | Confidence score 0.0–1.0               |
| `market_id`            | `uuid?`        | FK → `markets.id` (set null on delete) |
| `candidate_resolution` | `Boolean?`     | Proposed resolution outcome            |
| `created_at`           | `DateTime`     | Auto-set on insert                     |

### `UserPosition`

Aggregated position for a user in a market (updated on each fill).

| Column              | Type            | Notes                                 |
| ------------------- | --------------- | ------------------------------------- |
| `id`                | `uuid`          | Primary key                           |
| `market_id`         | `uuid`          | FK → `markets.id` (cascade delete)    |
| `user_address`      | `VarChar(56)`   | Stellar wallet address                |
| `yes_shares`        | `Int`           | Number of YES shares held             |
| `no_shares`         | `Int`           | Number of NO shares held              |
| `locked_collateral` | `Decimal(20,8)` | Collateral locked in open orders      |
| `is_settled`        | `Boolean`       | Whether the position has been settled |
| `updated_at`        | `DateTime`      | Auto-updated                          |

Unique constraint: `(market_id, user_address)`

### `ResolutionCandidate`

A proposed resolution submitted for a market, subject to a challenge window.

| Column             | Type                        | Notes                                      |
| ------------------ | --------------------------- | ------------------------------------------ |
| `id`               | `uuid`                      | Primary key                                |
| `market_id`        | `uuid`                      | FK → `markets.id` (cascade delete)         |
| `proposed_outcome` | `Boolean`                   | `true` = YES, `false` = NO                 |
| `source`           | `String`                    | Submitting oracle/source identifier        |
| `status`           | `ResolutionCandidateStatus` | Default `PROPOSED`                         |
| `confidence_score` | `Decimal(5,4)?`             | Confidence 0.0–1.0, null if not reported   |
| `operator_address` | `VarChar(56)`               | Stellar address of the submitting operator |
| `created_at`       | `DateTime`                  | Auto-set on insert                         |
| `updated_at`       | `DateTime`                  | Auto-updated                               |

### `Resolution`

The finalized resolution record for a market. At most one `ACTIVE` resolution per market (partial index).

| Column                         | Type               | Notes                                  |
| ------------------------------ | ------------------ | -------------------------------------- |
| `id`                           | `uuid`             | Primary key                            |
| `market_id`                    | `uuid`             | FK → `markets.id` (cascade delete)     |
| `outcome`                      | `Boolean`          | Final resolved outcome                 |
| `finalized_at`                 | `DateTime`         | When the resolution was finalized      |
| `provenance`                   | `String`           | Source/audit trail identifier          |
| `status`                       | `ResolutionStatus` | Default `ACTIVE`                       |
| `correction_override_metadata` | `Json?`            | JSONB history of corrections/overrides |
| `created_at`                   | `DateTime`         | Auto-set on insert                     |
| `updated_at`                   | `DateTime`         | Auto-updated                           |

Unique partial index: one `ACTIVE` resolution per `market_id`.

### `Position`

Snapshot-style position record per wallet/market/outcome (used for PnL queries).

| Column           | Type            | Notes                              |
| ---------------- | --------------- | ---------------------------------- |
| `id`             | `uuid`          | Primary key                        |
| `wallet_address` | `VarChar(56)`   | Stellar wallet address             |
| `market_id`      | `uuid`          | FK → `markets.id` (cascade delete) |
| `outcome`        | `Outcome?`      | `YES`, `NO`, or null               |
| `quantity`       | `Int`           | Share quantity                     |
| `valuation`      | `Decimal(20,8)` | Current valuation                  |
| `created_at`     | `DateTime`      | Auto-set on insert                 |
| `updated_at`     | `DateTime`      | Auto-updated                       |

Unique constraint: `(wallet_address, market_id, outcome)`

### `Trade`

CLOB-engine trade records. Written atomically with order fills; `trade_id` is the idempotency key preventing duplicate writes on retry.

| Column          | Type            | Notes                              |
| --------------- | --------------- | ---------------------------------- |
| `id`            | `uuid`          | Primary key                        |
| `trade_id`      | `VarChar(256)`  | Unique idempotency key             |
| `market_id`     | `uuid`          | FK → `markets.id`                  |
| `outcome`       | `Outcome`       | `YES` or `NO`                      |
| `buyer_address` | `VarChar(56)`   | Stellar wallet address of buyer    |
| `seller_address`| `VarChar(56)`   | Stellar wallet address of seller   |
| `buy_order_id`  | `uuid`          | FK reference to the buy order      |
| `sell_order_id` | `uuid`          | FK reference to the sell order     |
| `price`         | `Decimal(10,8)` | Execution price                    |
| `quantity`      | `Int`           | Quantity traded                    |
| `traded_at`     | `DateTime`      | When the trade occurred            |
| `created_at`    | `DateTime`      | Auto-set on insert                 |

Indexes: `market_id`, `buyer_address`, `seller_address`, `(buyer_address, traded_at DESC)`, `(seller_address, traded_at DESC)`

### `IndexedTrade`

On-chain trade events ingested by the indexer. Keyed by `idempotency_key` until fill reconciliation with CLOB orders exists.

| Column                 | Type           | Notes                                   |
| ---------------------- | -------------- | --------------------------------------- |
| `id`                   | `uuid`         | Primary key                             |
| `idempotency_key`      | `VarChar(64)`  | Unique; prevents duplicate ingestion    |
| `event_id`             | `String`       | Stellar event identifier                |
| `ledger`               | `Int`          | Ledger sequence number                  |
| `market_id`            | `String`       | Market identifier from on-chain event   |
| `trader_address`       | `VarChar(56)`  | Stellar address of the trader           |
| `counterparty_address` | `VarChar(56)`  | Stellar address of the counterparty     |
| `direction`            | `VarChar(8)`   | Trade direction (e.g. `BUY`, `SELL`)    |
| `outcome`              | `VarChar(8)`   | Outcome string from on-chain event      |
| `price_raw`            | `String`       | Raw price value (preserves precision)   |
| `quantity_raw`         | `String`       | Raw quantity value (preserves precision)|
| `buy_order_id`         | `String`       | Buy-side order reference                |
| `sell_order_id`        | `String`       | Sell-side order reference               |
| `created_at`           | `DateTime`     | Auto-set on insert                      |

Indexes: `market_id`, `ledger`

### `IndexerCursor`

Tracks the Stellar ledger cursor position for the indexer.

| Column         | Type       | Notes                             |
| -------------- | ---------- | --------------------------------- |
| `network_id`   | `String`   | Network identifier (composite PK) |
| `cursor_key`   | `String`   | Cursor type key (composite PK)    |
| `cursor_value` | `String?`  | Current cursor value              |
| `created_at`   | `DateTime` | Auto-set on insert                |
| `updated_at`   | `DateTime` | Auto-updated                      |

### `OracleSourceAlias`

Maps provider alias strings to canonical `OracleSource` enum values.

| Column             | Type           | Notes                      |
| ------------------ | -------------- | -------------------------- |
| `id`               | `Int`          | Auto-increment primary key |
| `alias`            | `String`       | Unique alias string        |
| `canonical_source` | `OracleSource` | Canonical enum value       |
| `created_at`       | `DateTime`     | Auto-set on insert         |

## API Response DTOs

### `GET /v1/wallets/:wallet/positions`

This is the single canonical endpoint for wallet position data — it replaces
the deprecated `/positions/user/:address` alias (see
[docs/api-versioning.md](api-versioning.md)). PnL is opt-in via
`?includePnl=true`; pricing requires an extra order-book query per market, so
it's skipped by default.

`WalletExposureRow`:

| Field              | Type                 | Notes                                |
| ------------------ | -------------------- | ------------------------------------ |
| `marketId`         | `string`             |                                      |
| `marketQuestion`   | `string`             |                                      |
| `yesShares`        | `number`             |                                      |
| `noShares`         | `number`             |                                      |
| `netExposure`      | `number`             | `yesShares - noShares`               |
| `lockedCollateral` | `string`             |                                      |
| `isSettled`        | `boolean`            |                                      |
| `updatedAt`        | `string` (date-time) |                                      |
| `pnlRealized`      | `string \| null`     | Only present when `includePnl=true`. |
| `pnlUnrealized`    | `string \| null`     | Only present when `includePnl=true`. |

`WalletPositionsResponse`:

| Field           | Type                  | Notes                                |
| --------------- | --------------------- | ------------------------------------ |
| `wallet`        | `string`              |                                      |
| `exposures`     | `WalletExposureRow[]` |                                      |
| `count`         | `number`              |                                      |
| `pnlRealized`   | `string`              | Only present when `includePnl=true`. |
| `pnlUnrealized` | `string`              | Only present when `includePnl=true`. |
| `pnlTotal`      | `string`              | Only present when `includePnl=true`. |
