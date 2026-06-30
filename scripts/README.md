# Scripts

Dev utilities for bootstrapping, database management, and maintenance tasks.

## Conventions

- Scripts are TypeScript, executed via `tsx` (no compile step needed)
- Add new scripts here rather than documenting one-off shell commands in chat
- Prefer shell-agnostic implementations; avoid bash-only syntax
- Scripts must be safe to run locally and in CI

## Execution

Run any script with:

```bash
npx tsx scripts/<script-name>.ts
# or via pnpm if a package.json script alias exists
pnpm <alias>
```

Scripts that require environment variables will fail fast with a clear error if they are missing. Copy `.env.example` to `.env` before running locally.

## Available Scripts

| Script                   | pnpm alias              | Purpose                                            |
| ------------------------ | ----------------------- | -------------------------------------------------- |
| `generate-keypair.ts`    | `pnpm generate:keypair` | Generate a Stellar keypair for oracle signing      |
| `validate-migrations.ts` | `pnpm prisma:validate`  | Validate Prisma migration files against the schema |

## Adding a Script

1. Create `scripts/<your-script>.ts`
2. Add a `pnpm` alias in `package.json` under `scripts` if it will be run frequently
3. Add a row to the table above
