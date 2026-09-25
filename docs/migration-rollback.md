# Migration Rollback Procedure

This document describes the safe rollback procedure for failed Prisma schema deployments.
It should be followed whenever a migration fails in staging or production.

---

## Pre-Checks

Before rolling back, confirm the following:

1. **Identify the failed migration** — check which migration was last applied:

   ```bash
   pnpm prisma migrate status
   ```

2. **Assess data impact** — determine whether the failed migration added, altered, or dropped columns/tables.

   > ⚠️ **Data-loss warning**: Rolling back a migration that dropped columns or tables is **not reversible** without a prior database backup. Always take a snapshot before deploying destructive migrations.

3. **Verify a backup exists** — confirm a recent database dump is available before proceeding:

   ```bash
   pg_dump $DATABASE_URL > backup_$(date +%Y%m%d_%H%M%S).sql
   ```

4. **Stop application traffic** — scale down or put the API into maintenance mode to prevent writes during rollback.

---

## Rollback Command

Prisma does not support automatic down-migrations. Rollback is performed by resolving the failed migration as rolled back and manually reverting the schema change.

### Step 1 — Mark the failed migration as rolled back

```bash
pnpm prisma migrate resolve --rolled-back <migration_name>
```

Replace `<migration_name>` with the directory name under `prisma/migrations/`, e.g.:

```bash
pnpm prisma migrate resolve --rolled-back 20260427000000_add_market_status_created_at_index
```

### Step 2 — Manually revert the database change

Apply the inverse SQL directly against the database. For example, to drop an index added by the failed migration:

```bash
psql $DATABASE_URL -c 'DROP INDEX IF EXISTS "markets_status_created_at_idx";'
```

> ⚠️ **Data-loss warning**: If the migration created a table or added a NOT NULL column with no default, reverting it will drop that table or column and any data it contains.

### Step 3 — Revert the schema file

Remove or undo the corresponding change in `prisma/schema.prisma` so the schema matches the rolled-back database state, then regenerate the client:

```bash
pnpm prisma:generate
```

---

## Post-Checks

After completing the rollback:

1. **Confirm migration status is clean**:

   ```bash
   pnpm prisma migrate status
   ```

   Expected output: all applied migrations listed, no pending or failed entries.

2. **Run the test suite** to confirm the application works against the rolled-back schema:

   ```bash
   pnpm test:run
   ```

3. **Restart the application** and verify the health endpoint responds correctly:

   ```bash
   curl http://localhost:3000/v1/health
   # Expected: {"status":"ok","service":"vatix-backend",...}
   ```

4. **Restore application traffic** once health checks pass.

---

## Recent Migrations

### `20260724074257_add_soft_delete_to_markets`

Adds a nullable `deleted_at TIMESTAMP(3)` column to `markets` plus `markets_deleted_at_idx`.

- **Rollback**: `DROP INDEX IF EXISTS "markets_deleted_at_idx";` then `ALTER TABLE "markets" DROP COLUMN IF EXISTS "deleted_at";`
- **Caveat**: this migration is additive (the column is nullable, no default required), so it is safely reversible on its own. However, any code deployed after this migration that has started soft-deleting rows (setting `deleted_at`) will lose that soft-delete state if the column is dropped — those rows will look active again. Confirm no application code is relying on `deleted_at` before rolling back, or you will need to re-derive which rows were soft-deleted from application logs/audit tables.

### `20260724080000_add_trades_traded_at_index`

Adds `trades_traded_at_idx` (`DESC`) on `trades.traded_at`.

- **Rollback**: `DROP INDEX IF EXISTS "trades_traded_at_idx";`
- **Caveat**: purely additive and safe to drop with no data loss. Watch for query-plan regressions on trade-history endpoints that order/filter by `traded_at` — rolling back removes the index they may now depend on.

## Expand/Contract Hazards

Migrations in this repo increasingly follow an **expand/contract** pattern (add the new shape, migrate/dual-write, then drop the old shape in a later migration). This has specific rollback implications:

- **Rolling back an "expand" migration** (e.g. adding a new nullable column or index, such as both migrations above) is generally safe — nothing depended on it yet, or the application can tolerate its absence.
- **Rolling back a "contract" migration** (one that drops a column, table, or constraint that a previous "expand" step introduced) is **not safely reversible** — the dropped data is gone. Never roll back a contract migration without a pre-migration backup, and treat `pnpm prisma:validate`'s `DROP TABLE`/`DROP COLUMN`/`DROP INDEX` warnings (see [migrations.md](./migrations.md#migration-validation)) as a signal to double-check which phase of an expand/contract pair you're reverting.
- If a failed deployment spans **both** an expand and a contract migration (e.g. a later migration drops a column added earlier), roll back in reverse order — contract migration first, then expand — and re-verify application compatibility at each step.

---

## Notes

- Always test rollback procedures in **staging** before a production incident occurs.
- Keep the `backup_*.sql` dump until the next successful deployment is confirmed.
- For complex migrations (multi-step schema changes), consider splitting them into smaller, independently reversible migrations.

---

_Linked from: [Deployment Runbook](./deployment-runbook.md) · [Migration Guide](./migrations.md)_
