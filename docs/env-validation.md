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

## API boot validation (`parseApiEnv`)

The HTTP API uses Zod to validate `NODE_ENV`, `PORT`, `DATABASE_URL`,
`ORACLE_CHALLENGE_WINDOW_SECONDS`, and `ORACLE_POLL_INTERVAL_MS` before
`buildServer()` runs. Invalid values throw with the same descriptive messages
as the legacy manual validators.

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

| Variable          | Accepted schemes               |
| ----------------- | ------------------------------ |
| `DATABASE_URL`    | `postgresql://`, `postgres://` |
| `REDIS_URL`       | `redis://`, `rediss://`        |
| `STELLAR_RPC_URL` | `https://`, `http://`          |

**Error example:**

```
DATABASE_URL must use one of [postgresql:, postgres:], got: "mysql:"
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

| Variable                                 | Min  | Max     | Default |
| ---------------------------------------- | ---- | ------- | ------- |
| `PORT`                                   | 1    | 65535   | `3000`  |
| `BODY_LIMIT_BYTES`                       | 1    | —       | `65536` |
| `RATE_LIMIT_MAX`                         | 1    | —       | `100`   |
| `RATE_LIMIT_WINDOW_MS`                   | 1    | —       | `60000` |
| `RATE_LIMIT_HEAVY_MAX`                   | 1    | —       | `20`    |
| `RATE_LIMIT_HEAVY_WINDOW_MS`             | 1    | —       | `60000` |
| `RATE_LIMIT_WRITE_MAX`                   | 1    | —       | `10`    |
| `RATE_LIMIT_WRITE_WINDOW_MS`             | 1    | —       | `60000` |
| `ORACLE_POLL_INTERVAL_MS`                | 5000 | 3600000 | `30000` |
| `ORACLE_CHALLENGE_WINDOW_SECONDS`        | 1    | —       | `86400` |
| `FINALIZATION_INTERVAL_MS`               | 1000 | —       | `60000` |
| `FINALIZATION_CHALLENGE_WINDOW_SECONDS`  | 0    | —       | `3600`  |
| `INDEXER_INGESTION_INTERVAL_MS`          | 100  | —       | `5000`  |
| `INDEXER_CHECKPOINT_FLUSH_EVERY_BATCHES` | 1    | —       | `10`    |

**Error example:**

```
PORT must be a positive integer, got: "abc"
PORT must be <= 65535, got: "99999"
```

### Optional strings with defaults

These variables are safe to omit; a sensible default is used when absent.

| Variable               | Default                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `STELLAR_NETWORK`      | `testnet`                                                                           |
| `STELLAR_HORIZON_URL`  | `https://horizon-testnet.stellar.org`                                               |
| `INDEXER_CURSOR_KEY`   | `ingestion`                                                                         |
| `INDEXER_NETWORK_ID`   | `mainnet`                                                                           |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:3000,http://localhost:5173` (non-production) / empty (production) |

### CORS origins

`CORS_ALLOWED_ORIGINS` is a comma-separated list of allowed browser origins.

```
CORS_ALLOWED_ORIGINS=https://app.vatix.io,https://staging.vatix.io
```

In production, if this variable is not set, **no cross-origin requests are
allowed**. In development and test the local dev server origins are permitted
by default.

---

## Security Notes

The following variables are treated as secrets and are **never logged** in full,
even at debug level:

- `DATABASE_URL` (may contain password)
- `REDIS_URL` (may contain password)
- `ORACLE_SECRET_KEY`
- `API_KEY`
- `ADMIN_TOKEN`

---

## Adding a New Variable

1. Add it to `.env.example` with a comment explaining purpose and whether it is required or optional.
2. Add the validation call in the appropriate loader in `packages/shared/src/config.ts` using the existing helpers (`requireString`, `requirePositiveInt`, `loadUrl`, etc.).
3. Add it to the relevant section of this document.
4. If it is required at startup, add it to the `requireEnv()` call in the service entry point.

---

## Testing Config Loaders

All loaders accept an optional `env` parameter, making them testable without
touching `process.env`:

```ts
import { loadBaseConfig } from "@vatix/shared";

it("throws when DATABASE_URL is missing", () => {
  expect(() =>
    loadBaseConfig({
      NODE_ENV: "test",
      STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
      // DATABASE_URL intentionally omitted
    })
  ).toThrow("Missing required environment variable: DATABASE_URL");
});
```

See `packages/shared/src/config.ts` for the full list of validation helpers.
