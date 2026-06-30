# Database Migrations - Positions Table

## Migration: Add Positions Table

**Migration ID:** `20260427000001_add_positions_table`

### Overview

This migration creates a `positions` table for wallet market positions snapshot/projection.
The table is designed for fast position queries using optimized read storage.

### Strategy: Snapshot vs Event-Derived

This migration implements a **snapshot-based strategy**:

- **Positions table** stores the current state of each wallet's position in a market.
- It is updated via **upsert** operations from the indexer whenever a trade occurs.
- This provides fast reads at the cost of slightly more complex writes.
- An alternative **event-derived strategy** would compute positions from trade events at query time, which saves storage but is slower for reads.

The snapshot strategy was chosen because:

1. Position queries are read-heavy (users frequently check their positions)
2. Snapshot reads are O(1) vs O(n) for event-derived
3. Upsert operations are idempotent and safe

### Table Structure

| Column         | Type          | Description                                 |
| -------------- | ------------- | ------------------------------------------- |
| id             | UUID          | Primary key                                 |
| wallet_address | VARCHAR(56)   | Stellar wallet address                      |
| market_id      | UUID          | Associated market                           |
| outcome        | Outcome       | YES or NO (nullable for combined positions) |
| quantity       | INTEGER       | Number of shares held                       |
| valuation      | DECIMAL(20,8) | Current valuation in base currency          |
| created_at     | TIMESTAMP     | When the position was first created         |
| updated_at     | TIMESTAMP     | When the position was last updated          |

### Indexes

- `positions_wallet_address_idx` - Fast lookup by wallet
- `positions_market_id_idx` - Fast lookup by market
- `positions_wallet_market_outcome_idx` - Unique constraint for upsert
