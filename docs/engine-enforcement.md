# Node 22 Engine Enforcement

This document describes how the Vatix Protocol monorepo enforces a single,
supported Node.js runtime across local development, CI, and production builds.
It is the source of truth for the `engines` field, the `.nvmrc` pin, and the CI
Node version used by `vatix-backend` and the other workspace packages.

## Invariants

1. **One supported major.** The monorepo targets Node.js **22** only. The
   supported range is `>=22 <23`.
2. **Fail closed on install.** Every package manifest declares
   `"engines": { "node": ">=22 <23" }`. Package managers that honor `engines`
   (npm with `engine-strict`, pnpm, Yarn) refuse to install on an unsupported
   runtime instead of silently building with a different Node.
3. **`.nvmrc` matches `engines`.** The repository `.nvmrc` pins `22` so that
   `nvm use` / `fnm use` selects the same major that `engines` allows.
4. **CI matches `.nvmrc`.** CI workflows read the Node version from `.nvmrc`
   (or pin `22` explicitly) so the enforcement is actually gated on every PR.
5. **No drift.** `.nvmrc`, `engines`, and CI must be updated together. A change
   to one without the others is a bug.

## Why Node 22

- Node 22 is the current LTS line and receives security updates.
- It provides a stable `fetch`, `AbortSignal.timeout`, and other runtime
  primitives the backend relies on for RPC/DB/Redis calls.
- Pinning a single major avoids "works on my machine" failures and keeps
  contributor environments reproducible for Stellar Wave contributors.

## Enforcement points

| Location | Mechanism | Effect |
| --- | --- | --- |
| `package.json` (`engines.node`) | `>=22 <23` | Install fails closed on unsupported Node when engine-strict is enabled. |
| `.nvmrc` | `22` | Version managers select Node 22. |
| CI workflow | `node-version-file: .nvmrc` | Builds/tests run on Node 22. |

## Local setup

```sh
# With nvm
nvm install
nvm use

# With fnm
fnm use

node --version   # must report v22.x.x
```

If your package manager does not enforce `engines` by default, enable strict
mode so unsupported runtimes fail closed:

```sh
npm config set engine-strict true
```

## Updating the supported Node version

When moving to a new Node major:

1. Update `engines.node` in every package manifest.
2. Update `.nvmrc` to the new major.
3. Update CI to read the new `.nvmrc` (no separate hard-coded version).
4. Update this document and any runbook that references the Node version.
5. Land the change behind the normal review process; document rollback in the
   PR description (revert the three files together).

## Rollback

Revert `.nvmrc`, the `engines` fields, and the CI Node version in a single
commit. Because the change is configuration-only and does not touch
money-path logic, rollback is safe and does not require a data migration.

## Related

- `.nvmrc`
- `package.json` (`engines`)
- CI workflow (Node version source)
- `docs/env-validation.md`
