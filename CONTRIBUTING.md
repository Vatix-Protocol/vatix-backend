# Contributing to vatix-backend

Thanks for contributing to Vatix-Protocol. This guide covers local setup, branch/PR
conventions, required checks, and the security expectations every change must meet.

## Prerequisites

- [Getting Started](#getting-started)
- [Finding Issues to Work On](#finding-issues-to-work-on)
- [Development Workflow](#development-workflow)
- [Code Guidelines](#code-guidelines)
- [Testing Requirements](#testing-requirements)
- [CI Required Checks](#ci-required-checks)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Database Changes](#database-changes)
- [Getting Help](#getting-help)

### Prerequisites

- Node.js 20+ and npm (see `package.json` `engines` if present).
- Git and a GitHub account with access to the repository.
- Optional: Docker for running local Postgres/Redis dependencies.

## Local setup

1. Fork and clone the repository, then add the upstream remote:
   ```bash
   git clone https://github.com/<you>/vatix-backend.git
   cd vatix-backend
   git remote add upstream https://github.com/Vatix-Protocol/vatix-backend.git
   ```
2. Install dependencies:
   ```bash
   npm ci
   ```
3. Copy the example environment file and fill in local values. Never commit real
   secrets — see [SECURITY.md](./SECURITY.md).
   ```bash
   cp .env.example .env
   ```
4. Run the scripts defined in `package.json` (for example `npm run build`,
   `npm test`, `npm run lint`). Use the actual script names from `package.json`
   rather than assuming defaults.

## Git hooks (Husky)

This repo uses [Husky](https://typicode.github.io/husky/) hooks in `.husky/`.
The `pre-commit` hook runs local lint/format/test checks so problems are caught
before they reach CI.

Hooks are **CI-safe**: in CI or any non-interactive environment the hook detects
that it is not running on a developer machine and exits successfully (no-op)
instead of failing the build. This means:

- Local commits still run the full pre-commit checks.
- CI, release automation, and other non-interactive runs are never blocked by
  the hook.
- If you need to bypass the hook locally, use `git commit --no-verify` (use
  sparingly; CI still enforces the same checks).

If you add or change a hook, keep it CI-safe: detect CI/non-interactive
environments (for example via the `CI` environment variable or a non-TTY stdin)
and no-op rather than failing, and never print secrets or tokens.

## Branch and commit conventions

- Branch from the latest `main`: `git checkout -b fix/<issue>-<short-slug>`.
- Keep branches focused on a single issue; avoid unrelated refactors.
- Write clear commit messages, e.g. `fix: <short description> (#<issue>)`.
- Rebase on `upstream/main` before opening or updating a PR.

## Pull requests

- Reference the issue number in the PR title and description.
- Describe the change, the invariants it preserves, and any rollback plan.
- Keep the diff minimal and scoped to the issue.
- Ensure all required checks pass before requesting review.

## Required checks (CI)

CI is defined in `.github/workflows/ci.yml`. At minimum, a PR must pass the
workflow jobs configured there (typically install, lint, build, and test). Run the
same commands locally before pushing:

```bash
npm ci
npm run lint
npm run build
npm test
```

If a check is not yet gated in CI, call it out in the PR description so reviewers
can verify it manually.

## Security and authorization expectations

- **Deny by default.** New privileged surfaces must be explicitly authorized;
  untrusted clients must not be able to bypass policy.
- **Authorize and rate-limit every external entrypoint.** See
  [RATE_LIMIT_POLICY.md](./RATE_LIMIT_POLICY.md) for the current policy.
- **No secrets in the repo or logs.** Do not commit credentials, tokens, or keys,
  and do not log sensitive values. Report vulnerabilities per
  [SECURITY.md](./SECURITY.md).
- **Server/contract is the source of truth** for balances, swaps, and admin
  actions. Clients are never trusted for these values.
- **Fail closed on writes.** If a dependency (RPC/DB/Redis) is unavailable, reject
  the write rather than proceeding with stale or partial state.
- **Idempotency.** Handle concurrent and replayed requests safely; use stable
  idempotency keys and correlation ids where applicable.
- **Stable error codes.** Return typed errors with stable codes so callers and
  ops tooling can react deterministically.

## Money-path changes

Any change that affects liquidity, trading, or settlement must:

- Be feature-flagged or behind a kill-switch when it could affect mainnet.
- Document the flag, its default, and the rollback procedure in the PR.
- Include tests covering the invariants and the failure modes above.
- Add ops-safe metrics/logs on the money path without leaking secrets.

## Testnet vs mainnet

Be explicit about which network a change targets. Watch for address drift and
configuration differences between testnet and mainnet, and never enable a
mainnet-affecting change without the readiness checklist.

## Documentation

Update `README.md`, runbooks, and cross-links (including `SECURITY.md` and
`RATE_LIMIT_POLICY.md`) when behavior, configuration, or operational procedures
change. Remove contradictory copy rather than leaving it in place.

## Questions

# Start dev server
pnpm dev
```

### 2. Make Your Changes

- Write clean, readable code
- Follow the existing code structure
- Add comments for complex logic
- Keep functions small and focused

### 3. Write Tests

**Every feature must include tests.** Add test files next to your implementation:

```
src/
├── services/
│   ├── database.ts
│   └── database.test.ts  ← Test file
```

Run tests frequently:

```bash
pnpm test
```

### 4. Commit Your Changes

Use clear, descriptive commit messages:

```bash
# Good commits
git commit -m "feat: add order validation logic"
git commit -m "fix: handle null values in position calculation"
git commit -m "test: add tests for order matching engine"

# Bad commits
git commit -m "update stuff"
git commit -m "fixes"
```

**Commit message format:**

- `feat:` - New feature
- `fix:` - Bug fix
- `test:` - Adding tests
- `docs:` - Documentation changes
- `refactor:` - Code refactoring
- `chore:` - Maintenance tasks

## Code Guidelines

### TypeScript

- **Use strict typing** - Avoid `any`
- **Define interfaces** for function parameters and return values
- **Export types** from `src/types/index.ts` for reuse

```typescript
// Good
interface CreateOrderParams {
  marketId: string;
  side: OrderSide;
  price: number;
}

async function createOrder(params: CreateOrderParams): Promise<Order> {
  // ...
}

// Bad
async function createOrder(marketId: any, side: any, price: any): Promise<any> {
  // ...
}
```

### Code Style

- **Use meaningful variable names**

```typescript
// Good
const activeMarkets = await getActiveMarkets();

// Bad
const x = await getActiveMarkets();
```

- **Keep functions small** - One function should do one thing
- **Avoid deep nesting** - Extract nested logic into separate functions
- **Add comments for complex logic** - But prefer self-documenting code

### File Organization

- One main export per file
- Related functions in the same file
- Test files next to implementation files
- Group related functionality in directories

```
src/matching/
├── engine.ts          # Main matching engine
├── engine.test.ts     # Engine tests
├── orderbook.ts       # Order book data structure
├── orderbook.test.ts  # Order book tests
└── validation.ts      # Order validation
```

## Testing Requirements

### What to Test

1. **Happy paths** - Normal, expected behavior
2. **Edge cases** - Boundary conditions, empty inputs
3. **Error cases** - Invalid inputs, database errors
4. **Integration** - Multiple components working together

### Test Structure

```typescript
import { describe, it, expect, beforeEach } from "vitest";

describe("Order Validation", () => {
  beforeEach(() => {
    // Setup before each test
  });

  it("should accept valid orders", () => {
    const order = { price: 0.5, quantity: 100 };
    expect(validateOrder(order)).toBe(true);
  });

  it("should reject orders with invalid price", () => {
    const order = { price: 1.5, quantity: 100 };
    expect(() => validateOrder(order)).toThrow();
  });
});
```

### Running Tests

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test src/matching/engine.test.ts

# Run with UI
pnpm test:ui

# Run with coverage
pnpm test:coverage
```

**All tests must pass before submitting a PR.**

## CI Required Checks

Every pull request against `main` or `dev` runs the **CI / Backend** job
(`.github/workflows/ci.yml`), and it must be green before the PR is merged.
The job runs the steps below in order and stops at the first failure, so run
the same commands locally before you push.

| #   | CI step                                | Run locally                                                                                             |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Verify Node 22 engine enforcement      | `node -v` must print `v22.*` (pinned in `.nvmrc`)                                                       |
| 2   | Install dependencies                   | `pnpm install`                                                                                          |
| 3   | Enforce engine parity (Node/pnpm)      | `pnpm engines:check`                                                                                    |
| 4   | Generate Prisma Client                 | `pnpm prisma:generate`                                                                                  |
| 5   | Check code formatting                  | `pnpm format:check` (fix with `pnpm format`)                                                            |
| 6   | Check TypeScript (src)                 | `pnpm tsc --noEmit`                                                                                     |
| 7   | Check TypeScript (apps + packages)     | `pnpm tsc --noEmit -p apps/tsconfig.json`                                                               |
| 8   | Check TypeScript (packages)            | `pnpm tsc --noEmit -p packages/tsconfig.json`                                                           |
| 9   | Validate migrations                    | `pnpm prisma:validate` (needs an empty `SHADOW_DATABASE_URL` database)                                  |
| 10  | Run migrations                         | `pnpm prisma:deploy`                                                                                    |
| 11  | Run unit tests (with coverage)         | `pnpm exec vitest run --exclude 'tests/integration/**' --exclude '**/*.integration.test.ts' --coverage` |
| 12  | Run integration tests (lease disabled) | `MATCHING_LEASE_ENFORCED=false pnpm test:integration`                                                   |
| 13  | Run integration tests (lease enforced) | `MATCHING_LEASE_ENFORCED=true pnpm test:integration`                                                    |
| 14  | Build                                  | `pnpm build`                                                                                            |

Steps 9–13 need Postgres and Redis (`docker compose up -d`) and the same
environment CI sets: `DATABASE_URL`, `REDIS_URL`, `NODE_ENV=test` and
`ADMIN_TOKEN=test-admin-token`.

Two other workflows run outside the Backend job:

- **Docker image non-root smoke test** (`.github/workflows/docker-smoke.yml`)
  runs only on PRs touching `Dockerfile`, `src/`, `apps/`, `packages/` or
  `prisma/schema.prisma`. It builds every image target and fails if a
  container runs as root. Fix a red run before merging.
- **Nightly Load Test** (`.github/workflows/nightly-load-test.yml`) runs on a
  schedule and on demand, never on PRs.

`tests/ci-required-checks.test.ts` fails if a step is added to or renamed in
the Backend job without updating this table.

## Submitting a Pull Request

### Before Submitting

- [ ] All tests pass (`pnpm test`)
- [ ] The [CI required checks](#ci-required-checks) pass locally
- [ ] Code follows style guidelines
- [ ] Added tests for new functionality
- [ ] Updated documentation if needed
- [ ] No console.logs or debug code
- [ ] Prisma Client regenerated if schema changed (`pnpm prisma:generate`)

### PR Description Template

```markdown
## Description

Brief description of what this PR does

## Related Issue

Closes #123

## Changes Made

- Added order validation logic
- Created validation tests
- Updated error handling

## Testing

- [ ] Unit tests added
- [ ] Integration tests added
- [ ] Manual testing completed
```

### PR Process

1. **Push your branch** to your fork
2. **Create a Pull Request** on GitHub
3. **Link the related issue** in the PR description
4. **Wait for review** from maintainers
5. **Address feedback** if requested
6. **Merge** once approved!

## Database Changes

### Adding/Modifying Models

1. **Edit** `prisma/schema.prisma`:

```prisma
   model Market {
     id          String   @id @default(uuid())
     question    String
     endTime     DateTime
     status      MarketStatus
     // ... other fields
   }
```

2. **Create migration**:

```bash
   pnpm prisma:migrate dev --name add_market_table
```

3. **Generate Prisma Client**:

```bash
   pnpm prisma:generate
```

4. **Test the changes**:

```bash
   pnpm test
```

### Migration Best Practices

- Name migrations descriptively: `add_orders_table`, `add_status_index`
- Never edit existing migrations
- Test migrations with both `up` and `down`
- Include migration in your PR

## Getting Help

### Questions?

- **Comment on the issue** you're working on

### Stuck?

Don't spend hours stuck! Ask for help early:

1. Describe what you're trying to do
2. Share what you've tried
3. Include error messages
4. Provide code snippets

### Code Review Feedback

- Reviews help improve code quality
- Don't take feedback personally
- Ask questions if feedback is unclear
- Make requested changes promptly

## Recognition

Contributors are recognized in:

- GitHub contributor list
- Project README (for significant contributions)
- Release notes

Thank you for contributing to Vatix!

## Testnet vs mainnet

Be explicit about which network a change targets. Watch for address drift and
configuration differences between testnet and mainnet, and never enable a
mainnet-affecting change without the readiness checklist.

## Documentation

Update `README.md`, runbooks, and cross-links (including `SECURITY.md` and
`RATE_LIMIT_POLICY.md`) when behavior, configuration, or operational procedures
change. Remove contradictory copy rather than leaving it in place.

## Questions

Open a discussion or issue, or reach out to maintainers. For security matters,
follow the private disclosure process in [SECURITY.md](./SECURITY.md).
