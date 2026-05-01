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
   curl http://localhost:3000/health
   # Expected: {"status":"ok","service":"vatix-backend"}
   ```

4. **Restore application traffic** once health checks pass.

---

## Notes

- Always test rollback procedures in **staging** before a production incident occurs.
- Keep the `backup_*.sql` dump until the next successful deployment is confirmed.
- For complex migrations (multi-step schema changes), consider splitting them into smaller, independently reversible migrations.

---

_Linked from: [Deployment Runbook](./deployment-runbook.md)_
