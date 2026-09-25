# Indexer Config Validation Hardening (Issue #1104)

## Problem

Without robust, fail-closed configuration validation at startup, the indexer risks operating with misconfigured network passphrases, mismatched contract IDs, or accidental mainnet execution without operator acknowledgment. Production-grade safety requires strict boot-time validation that surfaces stable error codes and variable names only, without leaking secrets.

## References

- `apps/indexer/src/config.ts`
- `packages/shared/src/config.ts`

## Invariants

1. **Fail-Closed Boot:** Any missing or invalid environment variable throws a typed `EnvValidationError` carrying a stable error code (`ENV_MISSING`, `ENV_INVALID`, `ENV_UNSAFE_MAINNET`) and the offending variable name. The process refuses to start.
2. **Secret Protection:** Error messages and logs never include secret values or credentials — only variable names and error codes.
3. **Mainnet Safety:** Booting against the global mainnet passphrase (`Public Global Stellar Network ; September 2015`) requires explicit operator opt-in via `VATIX_ALLOW_MAINNET=true` (or `1`). Unacknowledged mainnet boot throws `ENV_UNSAFE_MAINNET` and halts startup.
4. **Endpoint Resolution:** Stellar endpoints (`STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, and comma-separated lists) are validated against accepted transport protocols (`https:`, `http:`) and network passphrases.
5. **Deny-by-Default Access / Authz:** When the indexer HTTP surface is enabled (`INDEXER_HTTP_ENABLED=true`), all requests are subject to the shared CORS allowlist policy (failing closed in production when unset) and strict rate-limiting policies (`RATE_LIMIT_POLICIES`), preventing untrusted client bypass.

## Edge Cases & Failure Modes

- **Adversarial / Blank Input:** Blank or whitespace-only passphrases or contract IDs trigger `ENV_MISSING` or `ENV_INVALID`.
- **Mainnet Drift / Unsafe Boot:** Accidental execution of a testnet config against mainnet is blocked by the explicit mainnet opt-in guard.
- **Dependency Outage:** Ingestion and readiness probes fail closed when RPC, database, or rate-limit stores are unavailable.

## Observability & Metrics

- Configuration errors log structured messages with `error.code` and `variable` fields, omitting sensitive values.
- Metrics track ingestion health, cursor checkpoints, gap detection pause state, and HTTP rate-limiting/readiness.

## Rollback & Feature Flag Strategy

- If an indexer config change causes boot failures or issues, revert the environment configuration and restart.
- The indexer HTTP surface is feature-flagged behind `INDEXER_HTTP_ENABLED=false` by default, serving as a kill-switch for external read endpoints.
