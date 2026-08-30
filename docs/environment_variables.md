# Environment Variable Validation

This document outlines how environment variables are validated within the Vatix Backend to ensure application stability and fail-fast behavior during startup.

## Overview

The Vatix Backend utilizes automated validation schemas to enforce that all required environment variables are present and correctly typed before the server fully initializes. This prevents runtime crashes caused by missing configurations.

## Validation Layer

We use a validation layer that checks configurations immediately upon initialization.

### Key Checked Fields:

- **Server Configurations:** `PORT`, `NODE_ENV`
- **Database Credentials:** `DATABASE_URL`
- **Authentication Keys:** `JWT_SECRET`

> **`NODE_ENV` is a closed enum:** only `development`, `test`, or `production`
> are accepted (defaults to `development` when unset). Any other value —
> typos like `staging` or `prod` included — fails validation and the process
> exits before it can bind a port. See [env-validation.md](./env-validation.md)
> for the exact error message and full schema.

## Production-Only Stellar Configuration (Fail-Fast)

In **production** (`NODE_ENV=production`), the following Stellar RPC and smart contract environment variables are strictly **required**. If any are missing, the application exits non-zero at startup with a clear error message identifying exactly which variables are missing.

- **`STELLAR_RPC_URL`** or **`STELLAR_RPC_URLS`** — At least one explicit Stellar RPC endpoint (required; public defaults are not trusted)
- **`INDEXER_CONTRACT_ID`** or **`MARKET_CONTRACT_ID`** — Smart contract address for market data (required)
- **`SOROBAN_NETWORK_PASSPHRASE`** — Must match the declared network (checked against `STELLAR_NETWORK`)

### Oracle Worker (On-Chain Resolution)
- **`ORACLE_SECRET_KEY`** — Stellar secret key for signing resolution submissions (strictly required in production)

### Settlement Worker (On-Chain Settlement)
- **`STELLAR_SECRET_KEY`** — Stellar secret key for signing settlement transactions (strictly required in production)

### Development & Test Behavior
In **development** and **test** environments, incomplete Stellar config is allowed (with a warning log), permitting offline/off-chain-only development. Production deployment must have all variables explicitly configured.

### Why This Matters
Silent off-chain fallback in production is a critical bug — operators cannot distinguish between "settlement actually succeeded on-chain" and "settlement ran off-chain and looks successful but is unfunded." Production must fail loud and early.

## Local Setup

1. **Copy the Template:** Always ensure your local `.env` file matches the structure defined in `.env.example`.
2. **Missing Variables:** If a required variable is missing or fails validation, the application will log an error and terminate immediately on startup.

---

_For a full list of available keys, refer back to the root [README.md](../README.md)._
