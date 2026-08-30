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

| Script                   | pnpm alias              | Purpose                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate-keypair.ts`    | `pnpm generate:keypair` | Generate a Stellar keypair for oracle signing. Refuses to print the secret seed in CI / non-interactive / production; use `-- --out <path>` to write it to a `0600` file (see [docs/oracle-key-rotation.md](../docs/oracle-key-rotation.md#generating-a-keypair-safely))                                                                                              |
| `validate-migrations.ts` | `pnpm prisma:validate`  | Validate Prisma migration files against the schema                                                                                                                                                                                                                                                                                                                    |
| `check-engines.ts`       | `pnpm engines:check`    | Verify the running Node/pnpm satisfy `engines` and that `.nvmrc`, `engines.node`, and CI agree on one Node major (fail-fast in CI/production, warn-only locally — see [docs/engine-enforcement.md](../docs/engine-enforcement.md))                                                                                                                                    |
| `load-test-orders.ts`    | `pnpm load-test:orders` | Local-only load test: places signed orders against `POST /v1/orders` at a target rps; reports a `capacityRps` number for admission-watermark tuning and can fail on `--max-p95-ms` / `--min-success-rate` SLO gates (run nightly by `.github/workflows/nightly-load-test.yml`; see [docs/docker-compose.md](../docs/docker-compose.md#slo-gates--the-ci-nightly-job)) |
| `replay-market.ts`       | `pnpm replay:market`    | Read-only forensics: replays a market+outcome's order/trade history through the matching engine and diffs it against ledger truth and the Redis depth cache (see [docs/replay-forensics.md](../docs/replay-forensics.md))                                                                                                                                             |

## Adding a Script

1. Create `scripts/<your-script>.ts`
2. Add a `pnpm` alias in `package.json` under `scripts` if it will be run frequently
3. Add a row to the table above
