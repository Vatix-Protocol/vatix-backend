# Resolutions Table Migration - Testing & Verification Guide

## Overview

This migration adds the `resolutions` table to support finalized market resolutions. The table includes:

- **Market ID keying**: Each resolution is linked to a market
- **One active resolution per market**: Enforced via partial unique index on `market_id` WHERE `status = 'ACTIVE'`
- **Outcome tracking**: Boolean field for YES/NO resolution
- **Finalized timestamp**: When the resolution became final
- **Provenance**: Source attribution (oracle, manual, override, etc.)
- **Correction/Override metadata**: JSONB field for tracking historical corrections and overrides

## Migration Details

**Migration Name**: `20260428000000_add_resolutions_table`  
**Location**: `prisma/migrations/20260428000000_add_resolutions_table/migration.sql`

### Schema Changes

#### New Enum: ResolutionStatus

```
ACTIVE       - Current active resolution
CORRECTED    - Resolution that has been corrected (new one is ACTIVE)
OVERRIDDEN   - Resolution that was overridden (new one is ACTIVE)
```

#### New Table: resolutions

```sql
CREATE TABLE "resolutions" (
    "id" TEXT PRIMARY KEY,
    "market_id" TEXT NOT NULL,           -- References markets.id (CASCADE delete)
    "outcome" BOOLEAN NOT NULL,          -- YES (true) or NO (false)
    "finalized_at" TIMESTAMP NOT NULL,   -- When resolution finalized
    "provenance" TEXT NOT NULL,          -- Source (CHAINLINK, PYTH, MANUAL, etc.)
    "status" ResolutionStatus DEFAULT 'ACTIVE',
    "correction_override_metadata" JSONB, -- Correction/override history
    "created_at" TIMESTAMP,
    "updated_at" TIMESTAMP
);
```

#### Indexes Created

- `resolutions_market_id_active_idx` (unique, partial) - Enforces one ACTIVE resolution per market
- `resolutions_market_id_idx` - Fast lookups by market
- `resolutions_status_idx` - Filter by resolution status
- `resolutions_finalized_at_idx` - Temporal queries
- `resolutions_market_id_status_idx` - Compound filtering
- `resolutions_created_at_idx` - Pagination/ordering

## Testing Steps

### 1. Apply Migration

```bash
# Development environment
pnpm prisma:migrate dev --name "verify resolutions migration"

# Production environment
pnpm prisma:deploy
```

### 2. Verify Schema in Database

```bash
# Connect to database and check table structure
pnpm prisma:studio

# Or use SQL directly
psql $DATABASE_URL -c "\d resolutions"
```

Expected output should show all columns with correct types.

### 3. Test Acceptance Criteria

#### A. Resolution Keyed by Market ID

```sql
-- Insert a market first
INSERT INTO markets (id, question, end_time, resolution_time, oracle_address, status)
VALUES (
  'test-market-1',
  'Will Bitcoin reach $100k?',
  NOW() + INTERVAL '30 days',
  NOW() + INTERVAL '31 days',
  'GBXYZ...',
  'ACTIVE'
);

-- Insert a resolution
INSERT INTO resolutions (id, market_id, outcome, finalized_at, provenance, status)
VALUES (
  'res-1',
  'test-market-1',
  true,
  NOW(),
  'CHAINLINK',
  'ACTIVE'
);

-- Verify retrieval by market_id
SELECT * FROM resolutions WHERE market_id = 'test-market-1';
```

#### B. Outcome, Finalized At, and Provenance Fields

```sql
-- Verify all fields are populated correctly
SELECT id, market_id, outcome, finalized_at, provenance, status
FROM resolutions
WHERE market_id = 'test-market-1';

-- Expected: outcome=true, finalized_at=<timestamp>, provenance='CHAINLINK', status='ACTIVE'
```

#### C. One Active Resolution Per Market (Constraint)

```sql
-- This should FAIL (unique constraint violation)
INSERT INTO resolutions (id, market_id, outcome, finalized_at, provenance, status)
VALUES (
  'res-2',
  'test-market-1',
  false,
  NOW(),
  'MANUAL',
  'ACTIVE'
);

-- Expected Error: duplicate key value violates unique constraint "resolutions_market_id_active_idx"

-- This should SUCCEED (different status)
INSERT INTO resolutions (id, market_id, outcome, finalized_at, provenance, status)
VALUES (
  'res-2',
  'test-market-1',
  false,
  NOW(),
  'MANUAL',
  'CORRECTED'
);

-- Verify only one ACTIVE per market
SELECT status, COUNT(*) FROM resolutions GROUP BY market_id, status HAVING COUNT(*) > 1;
-- Expected: (empty result)
```

#### D. Correction/Override Metadata Strategy

```sql
-- Test with correction metadata
UPDATE resolutions
SET status = 'CORRECTED',
    correction_override_metadata = jsonb_build_object(
      'corrected_at', NOW()::text,
      'previous_outcome', false,
      'reason', 'Data validation error in oracle source',
      'corrected_by', 'oracle-ops'
    )
WHERE id = 'res-1';

-- Verify metadata was stored
SELECT id, status, correction_override_metadata
FROM resolutions
WHERE id = 'res-1';

-- Example metadata structure
-- {
--   "corrected_at": "2026-04-28T14:30:00Z",
--   "previous_outcome": false,
--   "reason": "Data validation error in oracle source",
--   "corrected_by": "oracle-ops"
-- }
```

### 4. Integration with Prisma ORM

#### Generate Prisma Client

```bash
pnpm prisma:generate
```

#### Usage Example (TypeScript)

```typescript
import { prisma } from "@/services/prisma";

// Create a resolution
const resolution = await prisma.resolution.create({
  data: {
    marketId: "market-123",
    outcome: true,
    finalizedAt: new Date(),
    provenance: "CHAINLINK",
    status: "ACTIVE",
  },
});

// Query active resolutions
const activeResolutions = await prisma.resolution.findMany({
  where: { status: "ACTIVE" },
  include: { market: true },
});

// Get resolution for specific market
const marketResolution = await prisma.resolution.findUniqueOrThrow({
  where: {
    marketId_status: {
      marketId: "market-123",
      status: "ACTIVE",
    },
  },
});

// Update resolution to corrected with metadata
const corrected = await prisma.resolution.update({
  where: { id: "res-123" },
  data: {
    status: "CORRECTED",
    correctionOverrideMetadata: {
      corrected_at: new Date().toISOString(),
      previous_outcome: false,
      reason: "Oracle data validation issue",
    },
  },
});
```

### 5. Run Full Test Suite

```bash
# Run all tests including integration tests
pnpm test

# Run specific test file
pnpm test tests/integration/

# Check test coverage
pnpm test:coverage
```

## Verification Queries

### Check Migration Applied

```sql
SELECT * FROM "_prisma_migrations"
WHERE migration = '20260428000000_add_resolutions_table'
ORDER BY finished_at DESC LIMIT 1;
```

### View Table Structure

```sql
\d resolutions
```

### Verify Indexes

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'resolutions';
```

### Test Constraint

```sql
-- Count ACTIVE resolutions per market (should be 0 or 1 for each)
SELECT market_id, COUNT(*) as active_count
FROM resolutions
WHERE status = 'ACTIVE'
GROUP BY market_id
HAVING COUNT(*) > 1;
-- Expected: (empty result - no violations)
```

## Rollback Plan

If you need to rollback this migration:

```bash
# Development environment
pnpm prisma:migrate resolve --rolled-back 20260428000000_add_resolutions_table

# Production environment
pnpm prisma:migrate resolve --rolled-back 20260428000000_add_resolutions_table --skip-generate
```

Manual SQL rollback (if needed):

```sql
DROP TABLE IF EXISTS resolutions CASCADE;
DROP TYPE IF EXISTS "ResolutionStatus";
```

## Notes

1. **Cascade Deletes**: When a market is deleted, all associated resolutions are automatically deleted
2. **Corrected/Overridden Tracking**: Use `correctionOverrideMetadata` JSONB field to maintain audit trail
3. **Partial Unique Index**: Only `ACTIVE` resolutions are enforced as unique per market, allowing historical tracking
4. **Sentinel Provenance Values**: Use standardized provenance values (e.g., 'CHAINLINK', 'PYTH', 'MANUAL', 'OVERRIDE', 'API3', 'UMA')

## Success Criteria

✅ Migration applies without errors  
✅ Table structure matches schema  
✅ One ACTIVE resolution per market constraint enforced  
✅ Correction metadata is stored and retrievable  
✅ Foreign key cascades work correctly  
✅ All indexes created successfully  
✅ Prisma ORM client generates successfully
