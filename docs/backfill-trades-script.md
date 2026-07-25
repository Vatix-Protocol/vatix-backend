# Backfill Trades from Audit Stream

## Overview

This script backfills the `trades` table in PostgreSQL from the Redis audit stream (`audit:trades:global`). It should be run once after deploying the trades table migration to seed historical trade records that predate durable database writes.

## Usage

```bash
npx tsx scripts/backfill-trades.ts
```

## How It Works

1. **Reads from Redis Stream**: Fetches trade records from the `audit:trades:global` stream in batches of 500
2. **Upserts to Database**: Inserts or updates records in the `trades` table, keyed by `tradeId`
3. **Idempotent**: Safe to re-run multiple times; subsequent runs skip existing records

## Implementation Details

- **Batch Size**: 500 records per iteration (configurable via `BATCH` constant)
- **Cursor Management**: Uses Redis stream ID tracking to resume from the last processed record
- **Error Handling**: On error, logs and exits with code 1
- **Cleanup**: Disconnects from both Redis and Prisma after completion

## Data Mapping

Maps audit stream fields to database columns:

- `tradeId` → `trade_id` (unique identifier)
- `marketId` → `market_id`
- `outcome` → `outcome`
- `buyerAddress` → `buyer_address`
- `sellerAddress` → `seller_address`
- `buyOrderId` → `buy_order_id`
- `sellOrderId` → `sell_order_id`
- `price` → `price`
- `quantity` → `quantity` (parsed as integer)
- `timestamp` → `traded_at` (converted to Date)

## Prerequisites

- PostgreSQL database with `trades` table (from migration)
- Redis connection with populated `audit:trades:global` stream
- Environment variables configured for database and Redis connections

## Example Output

```
Starting trades backfill from Redis audit stream…
Backfill complete. Upserted 1250 trade(s).
```
