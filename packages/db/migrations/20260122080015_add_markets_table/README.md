# Migration: Add Markets Table

**Migration ID:** `20260122080015_add_markets_table`

Creates the `markets` table — the core entity for all prediction market data.

## Table Structure

| Column            | Type          | Nullable | Description                        |
| ----------------- | ------------- | -------- | ---------------------------------- |
| id                | UUID          | No       | Primary key                        |
| question          | TEXT          | No       | Market question                    |
| end_time          | TIMESTAMPTZ   | No       | When the market closes             |
| resolution_time   | TIMESTAMPTZ   | Yes      | When the market was resolved       |
| oracle_address    | VARCHAR(56)   | No       | Stellar address of the oracle      |
| status            | MarketStatus  | No       | `ACTIVE`, `RESOLVED`, `CANCELLED`  |
| outcome           | BOOLEAN       | Yes      | Final outcome once resolved        |
| created_at        | TIMESTAMPTZ   | No       | Row creation timestamp             |
| updated_at        | TIMESTAMPTZ   | No       | Last update timestamp              |

## Indexes

- `markets_status_idx` — filter by status
- `markets_end_time_idx` — filter/sort by end time
- `markets_status_end_time_idx` — combined status + end time queries
- `markets_status_created_at_idx` — sorted market listings by creation date
