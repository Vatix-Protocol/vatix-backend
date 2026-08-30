# Soft-Deleted Markets (deletedAt) - Implementation Guide

## Overview

Soft-deleted markets are markets marked for deletion via the `deletedAt` timestamp but not physically removed from the database. This document describes how Vatix ensures deleted markets are filtered consistently across all components to prevent "ghost market" attacks where deleted markets could still accept orders or be modified by admin operations.

## Problem Statement

Without consistent `deletedAt` filtering, deleted markets could:
- Still accept orders through admin routes while being hidden from public APIs
- Be modified via break-glass operations despite appearing deleted
- Be processed by background jobs (oracle resolution, expiry, reconciliation)
- Be verified or modified through audit verification endpoints
- Be returned to internal API consumers (indexer)

This creates a **ghost market** vulnerability where operations silently fail or succeed unpredictably.

## Solution: Consistent deletedAt Filtering

All database queries for markets must check `deletedAt: null` to exclude soft-deleted markets. This is enforced at two levels:

### 1. Query-Level: WHERE Clauses

For queries returning multiple markets (`findMany`), use the `where` clause:

```typescript
// ✅ CORRECT
const markets = await prisma.market.findMany({
  where: { 
    status: { in: ["ACTIVE"] },
    deletedAt: null,  // Filter soft-deleted
  },
});

// ❌ WRONG - Silent inclusion of deleted markets
const markets = await prisma.market.findMany({
  where: { 
    status: { in: ["ACTIVE"] },
  },
});
```

### 2. Logic-Level: Explicit Checks

For single-record queries (`findUnique`), always check `deletedAt`:

```typescript
// ✅ CORRECT
const market = await prisma.market.findUnique({ where: { id } });
if (!market || market.deletedAt !== null) {
  throw new MarketNotFoundError(id);
}

// ❌ WRONG - Does not check deletedAt
const market = await prisma.market.findUnique({ where: { id } });
if (!market) {
  throw new MarketNotFoundError(id);
}
```

## Fixed Components

The following components have been updated to include `deletedAt` checks:

### 1. Admin API Routes (`src/api/routes/admin.ts`)

#### GET /admin/markets

**Fix**: Added `where: { deletedAt: null }` clause

```typescript
// Lists all non-deleted markets (status: ACTIVE, RESOLVED, CANCELLED)
const markets = await prisma.market.findMany({
  where: { deletedAt: null },
  orderBy: { createdAt: "desc" },
});
```

**Behavior**:
- Returns only non-deleted markets
- Production: Consistent with all other components
- Admin cannot view deleted markets in the admin panel

#### PATCH /admin/markets/:id/status

**Fix**: Added `market.deletedAt !== null` check

```typescript
const existing = await prisma.market.findUnique({ where: { id } });
if (!existing || existing.deletedAt !== null) {
  throw new MarketNotFoundError(id);
}
```

**Behavior**:
- Rejects status updates on deleted markets with 404 Market Not Found
- Production: Fail-fast error, consistent with public API behavior

### 2. Break-Glass Service (`src/services/break-glass.ts`)

#### executeWithApproval

**Fix**: Added `market.deletedAt !== null` check

```typescript
const market = await this.prisma.market.findUnique({
  where: { id: action.marketId },
});

if (!market || market.deletedAt !== null) {
  throw new Error(`Market ${action.marketId} not found`);
}
```

**Behavior**:
- Halt, cancel-all, and resume operations are rejected for deleted markets
- Production: Fail-fast, no silent bypasses

### 3. Indexer API Routes (`apps/indexer/src/routes/markets.ts`)

#### GET /markets

**Fix**: Added `deletedAt: null` to `where` clause

```typescript
const where: Prisma.MarketWhereInput = {
  deletedAt: null,
  ...(status && { status: status as MarketStatus }),
};

const markets = await prisma.market.findMany({
  where,
  orderBy: { createdAt: "desc" },
  take: limit,
});
```

**Behavior**:
- Returns only non-deleted markets
- Status filter combines with deletedAt check (AND logic)

#### GET /markets/:id

**Fix**: Added `market.deletedAt !== null` check

```typescript
const market = await prisma.market.findUnique({ where: { id } });
if (!market || market.deletedAt !== null) {
  return reply.status(404).send({ error: "Market not found" });
}
```

**Behavior**:
- Returns 404 for deleted markets
- Indexer clients see consistent behavior with public API

### 4. Audit Verification (`src/api/routes/audit-verification.ts`)

#### POST /audit/verify-chain

**Fix**: Added `market.deletedAt !== null` check

```typescript
const market = await prisma.market.findUnique({
  where: { id: marketId },
});

if (!market || market.deletedAt !== null) {
  throw new ValidationError("Market not found");
}
```

**Behavior**:
- Rejects verification requests for deleted markets
- Audit trails cannot be verified for deleted markets

### 5. Oracle Service (`apps/oracle/main.ts`)

#### poll()

**Fix**: Added `deletedAt: null` to `where` clause

```typescript
const markets = await prisma.market.findMany({
  where: { 
    status: { in: [...RESOLVABLE_MARKET_STATUSES] },
    deletedAt: null,  // Skip deleted markets
  },
  select: { id: true, oracleAddress: true },
});
```

**Behavior**:
- Oracle resolution only processes non-deleted markets
- Production: No silent resolution attempts on deleted markets
- Prevents orphaned resolution reports

## Error Messages and Codes

All components use consistent error semantics:

| Scenario | Error Type | HTTP Status | Message |
|----------|-----------|-------------|---------|
| Market not found (any reason) | MarketNotFoundError / ValidationError | 404 | "Market not found" or "Market {id} not found" |
| Break-glass on deleted market | Error | N/A | "Market {id} not found" |
| Audit verify on deleted market | ValidationError | 400 | "Market not found" |

## Production vs. Development

**Same behavior in all environments:**
- No environment-specific fallbacks
- No local stubs that bypass deletedAt checks
- No conditional logic based on NODE_ENV
- Consistent error handling across production and development

```typescript
// ✅ Same check everywhere
if (!market || market.deletedAt !== null) {
  throw error;
}

// ❌ NO environment-specific bypasses
if (!market || (NODE_ENV !== 'production' && market.deletedAt === null)) {
  // FORBIDDEN: Never do this
}
```

## Testing

All fixes are covered by unit tests in `tests/deleted-markets-fixes.test.ts`:

- Admin routes: 3 tests
- Break-glass: 4 tests
- Indexer routes: 4 tests
- Audit verification: 2 tests
- Oracle polling: 2 tests
- Cross-component consistency: 3 tests
- Production safety: 3 tests
- Edge cases: 4 tests

Run tests with:

```bash
npm run test -- deleted-markets-fixes.test.ts --run
```

## Logging and Metrics

Deleted market rejections are logged at appropriate levels:

- Admin/Audit rejections: Logged with warning level (expected in normal operations)
- Break-glass rejections: Logged with error level (unexpected operational action)
- Oracle skips: Logged at debug level (expected filtering)

Example log entry:

```json
{
  "level": "warn",
  "component": "admin-api",
  "action": "market_not_found",
  "marketId": "market-123",
  "deletedAt": "2026-02-20T10:30:00Z",
  "message": "Attempted to modify deleted market"
}
```

## Runbook: Operationalizing Deleted Markets

### Monitoring

Monitor these metrics to detect potential attacks:
- `admin.market_not_found`: Rate of 404s on admin endpoints
- `breakglass.market_not_found`: Rate of deleted market rejection in break-glass
- `oracle.skipped_deleted_markets`: Count of markets skipped by oracle polling

Alert thresholds:
- Critical: >10 failed admin operations per minute (indicates targeted attack or data corruption)
- Warning: >1 break-glass operation on deleted market per day

### Troubleshooting

**Q: Why am I getting "Market not found" for a market I just deleted?**

A: After soft-deleting a market (setting `deletedAt`), it's immediately invisible to all APIs. This is intentional and prevents any further operations on that market. If you need to undo the deletion, contact database administrators to clear `deletedAt`.

**Q: Can I query deleted markets for audit/reporting?**

A: Deleted markets are excluded from all standard APIs. For historical audit, query the database directly with explicit `deletedAt IS NOT NULL` filters or access audit tables directly.

**Q: What if a market was deleted but orders are still pending?**

A: Resting orders are NOT automatically cancelled when a market is soft-deleted. Use the break-glass "cancel-all" operation before deletion to cancel all orders, or handle cancellation separately.

## Related Documentation

- **Market Lifecycle**: `docs/architecture.md` - Describes market statuses and transitions
- **Audit Trail**: `docs/audit.md` - Explains audit logging and verification
- **Admin Operations**: `docs/admin-operations.md` - Break-glass and emergency procedures
- **Database Schema**: `prisma/schema.prisma` - Market table definition and constraints

## Summary

Soft-deleted markets are fully filtered across all components through:
1. Explicit `where: { deletedAt: null }` in findMany queries
2. Explicit checks `if (!market || market.deletedAt !== null)` in findUnique paths
3. Consistent error messages across all components
4. No environment-specific bypasses
5. Comprehensive test coverage

This ensures the "ghost market" vulnerability cannot occur and production operations remain predictable.
