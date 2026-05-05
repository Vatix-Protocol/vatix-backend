# Database Migration Guide

This document provides comprehensive instructions for managing database migrations in the vatix-backend project using Prisma.

## Overview

The vatix-backend uses **Prisma** as the database migration tool, which is already aligned with our PostgreSQL stack and provides type-safe database access.

## Prerequisites

- Node.js >= 18.0.0
- PostgreSQL database
- Environment variables configured (see `.env.example`)

## Environment Setup

Create a `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Ensure the following environment variables are set:

```env
# Database connection
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/vatix"

# Redis (for production)
REDIS_URL="redis://localhost:6379"

# Node environment
NODE_ENV="development"
```

## Migration Commands

### Create New Migration

To create a new migration after modifying `prisma/schema.prisma`:

```bash
# Generate migration file with descriptive name
npm run prisma:migrate -- --name add_new_feature

# Or using pnpm
pnpm prisma:migrate -- --name add_new_feature
```

This will:

1. Compare schema changes with current database state
2. Generate migration SQL in `prisma/migrations/`
3. Apply the migration to the database
4. Generate updated Prisma Client

### Apply Migrations (Production)

To apply migrations without creating new ones (production deployment):

```bash
npm run prisma:migrate deploy
# or
pnpm prisma:migrate deploy
```

### Reset Database

**⚠️ WARNING: This will delete all data**

```bash
npm run prisma:migrate reset
# or
pnpm prisma:migrate reset
```

### Generate Prisma Client

After schema changes, regenerate the client:

```bash
npm run prisma:generate
# or
pnpm prisma:generate
```

### View Database

Open Prisma Studio to inspect database content:

```bash
npm run prisma:studio
# or
pnpm prisma:studio
```

## Migration File Structure

Migration files are stored in `prisma/migrations/` with timestamp prefixes:

```
prisma/migrations/
├── 20260122080015_init/
│   └── migration.sql
├── 20260123090000_add_new_feature/
│   └── migration.sql
└── migration_lock.toml
```

### Migration File Naming

- Use descriptive, snake_case names
- Include timestamp automatically added by Prisma
- Example: `add_user_preferences`, `create_order_indexes`

## Best Practices

### Schema Changes

1. **Always review generated SQL** before applying
2. **Test migrations on staging** before production
3. **Use descriptive migration names**
4. **Consider data preservation** for destructive changes

### Migration Development

1. **Make incremental changes** - one logical change per migration
2. **Add indexes** for performance improvements
3. **Use constraints** for data integrity
4. **Document complex migrations** in comments

### Production Deployment

1. **Backup database** before major migrations
2. **Test migrations** on staging environment
3. **Use `migrate deploy`** (not `migrate dev`) in production
4. **Monitor migration logs** for errors

## CI/CD Integration

The CI pipeline includes migration checks:

```yaml
# From .github/workflows/ci.yml
- name: Run migrations
  run: pnpm prisma:migrate deploy
  env:
    DATABASE_URL: postgresql://postgres:postgres@localhost:5432/vatix
```

### Migration Validation

To check if migrations are in sync with schema:

```bash
# This will fail if schema and migrations don't match
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma
```

## Common Migration Scenarios

### Adding New Table

```prisma
model NewTable {
  id        String   @id @default(uuid())
  createdAt DateTime @default(now())

  @@map("new_tables")
}
```

### Adding New Column

```prisma
model Market {
  // ... existing fields
  newField String?
}
```

### Adding Index

```prisma
model Market {
  // ... existing fields

  @@index([status, endTime])
}
```

### Changing Column Type

**⚠️ Requires careful planning for existing data**

1. Create migration with type change
2. Test data conversion
3. Consider multi-step migration for complex changes

## Troubleshooting

### Common Issues

1. **Migration lock stuck**

   ```bash
   rm prisma/migrations/migration_lock.toml
   ```

2. **Database connection errors**
   - Check `DATABASE_URL` format
   - Verify PostgreSQL is running
   - Check database exists

3. **Schema drift**
   ```bash
   # Reset to match migration files
   npx prisma migrate reset
   ```

### Getting Help

- Check [Prisma Migration Docs](https://www.prisma.io/docs/concepts/components/prisma-migrate)
- Review generated SQL before applying
- Use `--preview-feature` flags for advanced features

## Rollback Strategy

Prisma doesn't support automatic rollbacks. Manual rollback process:

1. **Create rollback migration**

   ```bash
   npx prisma migrate dev --name rollback_feature_name
   ```

2. **Manually write reverse SQL** in the migration file

3. **Test rollback** thoroughly on staging

## Migration Scripts

The project includes several helpful scripts in `package.json`:

```json
{
  "prisma:generate": "prisma generate",
  "prisma:migrate": "prisma migrate dev",
  "prisma:studio": "prisma studio",
  "prisma:seed": "tsx prisma/seed.ts"
}
```

## Seed Data

To populate database with initial data:

```bash
npm run prisma:seed
# or
pnpm prisma:seed
```

This runs the seed script at `prisma/seed.ts` which can be customized for your needs.
