# Toolchain / Engine Enforcement

## Why

Local development on one Node major (e.g. 20) while CI runs another (e.g. 22)
lets version-specific breakage slip through review — a syntax/API difference
passes locally and only fails after merge, or worse, ships. For a
prediction-market backend that means trades, resolutions, or admin actions
silently failing in production.

This repo pins **one** Node major and **one** pnpm major, and enforces that
pin everywhere.

## Single source of truth

| Where                         | File / setting                                                        | Value      |
| ----------------------------- | --------------------------------------------------------------------- | ---------- |
| Version managers (`nvm`, ...) | `.nvmrc`                                                              | `22`       |
| Package manifest floor        | `package.json` → `engines.node`                                       | `>=22.0.0` |
| Package manifest floor        | `package.json` → `engines.pnpm`                                       | `>=10.0.0` |
| CI runner                     | `.github/workflows/ci.yml` → `actions/setup-node` `node-version-file` | `.nvmrc`   |
| Container image               | `Dockerfile` → `ARG NODE_VERSION`                                     | `22-*`     |

CI reads `.nvmrc` directly (`node-version-file: ".nvmrc"`), so bumping the
Node major is a one-line change to `.nvmrc` plus the `engines.node` floor.

## Enforcement layers

1. **`pnpm install` fail-fast** — `.npmrc` sets `engine-strict=true`, so pnpm
   refuses to install under a Node or pnpm version outside `engines`.
2. **`pnpm engines:check`** (`scripts/check-engines.ts`) — verifies the
   running Node/pnpm satisfy `engines` **and** that `.nvmrc`, the
   `engines.node` floor, and the CI workflow all agree on the same Node major.
   `engine-strict` cannot see config files drifting apart from each other;
   this can.
   - **CI (`CI` set) or `NODE_ENV=production`:** exits non-zero on any drift.
   - **Local dev:** warn-only (exit 0) — you get a nudge to run `nvm use`
     without being blocked mid-task.
3. **CI step** — `Enforce engine parity (Node/pnpm)` runs `pnpm engines:check`
   right after `pnpm install`, so a drifted `.nvmrc`/workflow/manifest fails
   the build.

## Bumping the Node or pnpm version

1. Update `.nvmrc` (Node) and/or `package.json` `engines` floors.
2. Update `Dockerfile` `ARG NODE_VERSION` to match the Node major.
3. Run `pnpm engines:check` locally, then `nvm use`.
4. `tests/config/engine-enforcement.test.ts` fails if any of these drift apart.
