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

## Local Setup

1. **Copy the Template:** Always ensure your local `.env` file matches the structure defined in `.env.example`.
2. **Missing Variables:** If a required variable is missing or fails validation, the application will log an error and terminate immediately on startup.

---

_For a full list of available keys, refer back to the root [README.md](../README.md)._
