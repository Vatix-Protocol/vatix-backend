# Contributing to vatix-backend

Thanks for contributing to Vatix-Protocol. This guide covers local setup, branch/PR
conventions, required checks, and the security expectations every change must meet.

## Prerequisites

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

Open a discussion or issue, or reach out to maintainers. For security matters,
follow the private disclosure process in [SECURITY.md](./SECURITY.md).
