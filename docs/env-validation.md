# Environment Variable Validation

This document describes how the `packages/shared` module validates environment
variables at service startup, covering the two complementary utilities:
`requireEnv` and `loadBaseConfig` / `loadIndexerConfig` / `loadFinalizationConfig`.

## Overview

All Vatix services validate their environment **at boot time** — not lazily at
the point of first use. A missing or malformed variable causes an immediate,
descriptive startup failure rather than a silent bug at runtime.

The **API server** validates its boot-time variables with a **Zod schema** in
`src/env.ts` (`parseApiEnv()`), called from `src/config.ts` at module load and
again in `src/index.ts` before the HTTP server binds.

Two utilities work together for other services:

| Utility                 | File                                | Purpose                        |
| ----------------------- | ----------------------------------- | ------------------------------ |
| `parseApiEnv()`         | `src/env.ts`                        | Zod schema for API boot env    |
| `requireEnv()`          | `packages/shared/src/requireEnv.ts` | Fail-fast presence check       |
| `loadBaseConfig()` etc. | `packages/shared/src/config.ts`     | Typed, validated config object |

---

## Fail-closed boot

Env validation is **fail-closed**: when validation fails the process refuses to
start. There is no partial boot and no silent fallback to defaults for required
secrets. A missing or malformed required variable aborts startup before any
listener binds, worker loop starts, or money-path code runs.

Every validation failure is reported with a **stable error code** so operators
and tests can assert on it without parsing free-form messages:

| Code                 | Meaning                                                       |
| -------------------- | ------------------------------------------------------------- |
| `ENV_MISSING`        | A required variable is absent or empty.                       |
| `ENV_INVALID`        | A variable is present but malformed (bad URL, enum, integer). |
| `ENV_UNSAFE_MAINNET` | Mainnet-affecting config was set without explicit opt-in.     |

Failures are logged with the **variable name and error code only** — never the
value — so secrets cannot leak into logs or crash reports.

```
[env] ENV_MISSING: DATABASE_URL
[env] ENV_INVALID: NODE_ENV must be one of development | test | production
[env] ENV_UNSAFE_MAINNET: STELLAR_NETWORK=mainnet requires ALLOW_MAINNET=true
```

### Testnet vs mainnet

`STELLAR_NETWORK` selects the target network. Testnet is the default and is
safe to boot. Any mainnet-affecting configuration requires an **explicit
opt-in** via `ALLOW_MAINNET=true`; without it, boot fails closed with
`ENV_UNSAFE_MAINNET`. This prevents an accidental mainnet boot from a testnet
config or a drifted address set.

---

## Contract ID boot validation (#1132)

The target Soroban contract is part of the boot contract, not a lazy lookup.
Indexer/oracle/worker processes resolve it through `loadIndexerContractId()`
(`packages/shared/src/config.ts`), which the indexer's fail-closed boot gate
(`validateEnv()` in `apps/indexer/src/config.ts`) calls directly — so a process
with no contract to ingest fails **before** any listener binds or polling loop
starts. Starting anyway would connect, poll, and silently index nothing.

| Variable              | Required | Notes                                                    |
| --------------------- | -------- | -------------------------------------------------------- |
| `INDEXER_CONTRACT_ID` | yes      | Preferred name.                                          |
| `MARKET_CONTRACT_ID`  | alias    | Legacy alias; ignored when `INDEXER_CONTRACT_ID` is set. |

Rules:

- Absent or blank everywhere → `ENV_MISSING` (`variable: INDEXER_CONTRACT_ID`).
- Both aliases present with **different** values → a warning is logged
  (half-rotated deployment / address drift) and `INDEXER_CONTRACT_ID` wins.
- `NODE_ENV=production` additionally requires a well-formed Stellar contract
  strkey (`C` + 55 base32 characters) → otherwise `ENV_INVALID`. A truncated or
  chain-mismatched ID would otherwise point the money path at the wrong
  contract, so production refuses to boot rather than run blind. Dev/test keep
  accepting short fixture IDs such as `CTESTCONTRACT`.
- Errors carry the variable **name and code only**, never the value.

```
[env] ENV_MISSING Missing required environment variable: INDEXER_CONTRACT_ID (or MARKET_CONTRACT_ID)
[env] ENV_INVALID INDEXER_CONTRACT_ID must be a Stellar contract strkey (C + 55 base32 chars), got: invalid value
```

### Metrics scrape authz boot gate (#1130)

The API refuses to boot in production without a `/metrics` authorization policy
(`METRICS_SCRAPE_TOKEN` or `METRICS_SCRAPE_ALLOWED_IPS`), unless
`METRICS_REQUIRE_AUTH=false` is set explicitly as a documented rollback. The
endpoint is excluded from the rate limiter and admission control, so this boot
check is what stops an unauthenticated scrape surface from shipping by
omission. See [Prometheus Metrics](metrics.md#scrape-authz-1130).

---

The HTTP API uses Zod to validate `NODE_ENV`, `PORT`, `DATABASE_URL`,
`ORACLE_CHALLENGE_WINDOW_SECONDS`, `ORACLE_POLL_INTERVAL_MS`,
`MATCHING_ENGINE_ENABLED`, `ANALYTICS_DATABASE_URL`, and `BODY_LIMIT_BYTES`
before `buildServer()` runs. Invalid values throw with the same descriptive
messages as the legacy manual validators.

```ts
import { parseApiEnv } from "./env.js";

parseApiEnv(); // reads process.env; throws on first invalid field
```

See `src/env.test.ts` for coverage.

---

## `requireEnv()`

A lightweight guard that asserts every listed variable is present and non-empty.
Call it once at the top of a service entry point before any other initialization.

```ts
import { requireEnv } from "@vatix/shared";

requireEnv(["DATABASE_URL", "API_KEY", "REDIS_URL"]);
```

If any variable is missing the process exits immediately with code `1` and
prints exactly which keys are absent:

```
[requireEnv] Missing required environment variables:
  - API_KEY
  - REDIS_URL
```

The function accepts an optional second argument for testing without touching
real environment state:

```ts
requireEnv(["DATABASE_URL"], { DATABASE_URL: "postgresql://..." });
```

---

## Typed Config Loaders

`config.ts` exports three loader functions that read `process.env`, validate
every field, and return a strongly-typed config object. Services pass this
object around instead of accessing `process.env` directly.

### `loadBaseConfig(env?)`

Used by the API server and any service that shares the core stack.

```ts
import { loadBaseConfig } from "@vatix/shared";

const config = loadBaseConfig(); // reads process.env
```

### `loadIndexerConfig(env?)`

Used by `apps/indexer`.

```ts
import { loadIndexerConfig } from "@vatix/shared";

const config = loadIndexerConfig();
```

### `loadFinalizationConfig(env?)`

Used by `apps/workers` finalization worker.

```ts
import { loadFinalizationConfig } from "@vatix/shared";

const config = loadFinalizationConfig();
```

All loaders accept an optional `env` parameter — a plain object — so they can
be called in unit tests without mutating `process.env`.

---

## Validation Rules

Each variable is validated according to its type. Invalid values throw a
descriptive error that prevents startup.

### Required strings

Variables that must be present and non-empty. Missing value → startup failure.

| Variable            | Used by      |
| ------------------- | ------------ |
| `DATABASE_URL`      | All services |
| `STELLAR_RPC_URL`   | All services |
| `ORACLE_SECRET_KEY` | API, Oracle  |
| `API_KEY`           | API          |
| `ADMIN_TOKEN`       | API          |

**Error example:**

```
Missing required environment variable: API_KEY
```

### URL variables

Must be a valid URL and use one of the accepted schemes.

| Variable                 | Accepted schemes               |
| ------------------------ | ------------------------------ |
| `DATABASE_URL`           | `postgresql://`, `postgres://` |
| `ANALYTICS_DATABASE_URL` | `postgresql://`, `postgres://` |
| `REDIS_URL`              | `redis://`, `rediss://`        |
| `STELLAR_RPC_URL`        | `https://`, `http://`          |

`ANALYTICS_DATABASE_URL` is optional — unset or empty is valid and the API
falls back to `DATABASE_URL` (see `config.analyticsDatabaseUrl` in
`src/config.ts`, consumed by `src/services/analytics-prisma.ts`). When set,
it must be a well-formed postgres URL just like `DATABASE_URL`.

**Error example:**

```
DATABASE_URL must use one of [postgresql:, postgres:], got: "mysql:"
```

### Network-matched Soroban RPC URLs

`STELLAR_RPC_URL` must belong to the network declared by `STELLAR_NETWORK`
(#1135). `loadBaseConfig()` and `loadIndexerConfig()` validate the pair at boot
and **fail closed** — an RPC endpoint on the wrong chain would serve contract
state and accept transaction submission for the wrong network:

- Known hosts are checked exactly: `soroban-testnet.stellar.org` ↔ testnet,
  `soroban.stellar.org` / `soroban-mainnet.stellar.org` ↔ mainnet (the
  endpoints documented in `.env.example` and used by `stellarTransport.ts`).
- Custom hosts containing a `testnet` or `mainnet` token
  (e.g. `rpc.testnet.example.com`) are checked too. Third-party providers with
  no network signal in the hostname are allowed — they cannot be verified from
  the URL alone.
- Unknown/custom `STELLAR_NETWORK` values (e.g. `futurenet`) skip the check, as
  there is no known-good host set.

**Error example:**

```
STELLAR_RPC_URL host "soroban-testnet.stellar.org" belongs to Stellar testnet, which does not match STELLAR_NETWORK="mainnet": expected a mainnet Soroban RPC endpoint (e.g. https://soroban.stellar.org)
```

### Enum variables

Must be one of a fixed set of string values.

| Variable                 | Accepted values                         | Default       |
| ------------------------ | --------------------------------------- | ------------- |
| `NODE_ENV`               | `development` \| `test` \| `production` | `development` |
| `LOG_LEVEL`              | `debug` \| `info` \| `warn` \| `error`  | `info`        |
| `ORACLE_LOG_LEVEL`       | `debug` \| `info` \| `warn` \| `error`  | `info`        |
| `FINALIZATION_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`  | `info`        |
| `INDEXER_LOG_LEVEL`      | `debug` \| `info` \| `warn` \| `error`  | `info`        |

**Error example:**

```
NODE_ENV must be one of development | test | production, got: "staging"
```

### Integer variables

Must be a positive integer, optionally within a bounded range.

| Variable                                 | Min  | Max     | Default                           |
| ---------------------------------------- | ---- | ------- | --------------------------------- |
| `PORT`                                   | 1    | 65535   | `3000`                            |
| `BODY_LIMIT_BYTES`                       | 1    | —       | `65536`                           |
| `RATE_LIMIT_MAX`                         | 1    | —       | `100`                             |
| `RATE_LIMIT_WINDOW_MS`                   | 1    | —       | `60000`                           |
| `RATE_LIMIT_HEAVY_MAX`                   | 1    | —       | `20`                              |
| `RATE_LIMIT_HEAVY_WINDOW_MS`             | 1    | —       | `60000`                           |
| `RATE_LIMIT_WRITE_MAX`                   | 1    | —       | `10`                              |
| `RATE_LIMIT_WRITE_WINDOW_MS`             | 1    | —       | `60000`                           |
| `RATE_LIMIT_ADMIN_MAX`                   | 1    | —       | `30`                              |
| `RATE_LIMIT_ADMIN_WINDOW_MS`             | 1    | —       | `60000`                           |
| `ORACLE_POLL_INTERVAL_MS`                | 5000 | 3600000 | `30000`                           |
| `ORACLE_CHALLENGE_WINDOW_SECONDS`        | 1    | —       | `86400`                           |
| `ORACLE_PRIMARY_TIMEOUT_MS`              | 1    | —       | `30000`                           |
| `ORACLE_FALLBACK_TIMEOUT_MS`             | 1    | —       | `30000`                           |
| `FINALIZATION_INTERVAL_MS`               | 1000 | —       | `60000`                           |
| `FINALIZATION_CHALLENGE_WINDOW_SECONDS`  | 0    | —       | `ORACLE_CHALLENGE_WINDOW_SECONDS` |
| `INDEXER_INGESTION_INTERVAL_MS`          | 100  | —       | `5000`                            |
| `INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES` | 1    | —       | `10`                              |
| `REDIS_MAX_RETRIES`                      | 1    | —       | `3`                               |
| `REDIS_RETRY_BASE_DELAY`                 | 1    | —       | `100`                             |
| `REDIS_RETRY_MAX_DELAY`                  | 1    | —       | `2000`                            |
| `REDIS_CONNECT_TIMEOUT`                  | 1    | —       | `5000`                            |
