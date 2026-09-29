# Indexer

The indexer consumes Stellar/Soroban events, persists market and trade state, and exposes a health endpoint used by orchestrators and load balancers.

## Startup health

On boot the indexer runs a startup health check before it begins consuming events. The check verifies that required dependencies are reachable, including Redis (used for dedupe/idempotency and checkpoint coordination).

### Fail-closed behavior

Startup health **fails closed**: if Redis is missing, misconfigured, or unreachable, the process does **not** report healthy and does **not** begin consuming events. There is no silent pass-through — a missing dependency is treated as a hard failure so the indexer never runs in a degraded state that could produce incorrect liquidity/trading/settlement state.

- Missing/unreachable Redis => startup health fails; the process exits non-zero (or stays unready) rather than serving traffic.
- The failure is surfaced with a stable error code and a correlation id so operators can trace the specific boot attempt.
- Logs and metrics are ops-safe: they report the failure and dependency name but never include Redis URLs, credentials, or other secrets.

### Observability

- A startup-health metric is emitted on both success and failure so dashboards/alerts can distinguish a fail-closed boot from a healthy one.
- Failure logs include the stable error code and correlation id, and are safe to ship to centralized logging.

### Rollback / kill-switch

Startup health is a boot-time gate. To roll back, redeploy the previous image; no runtime flag is required because the check only affects process startup and never mutates money-path state.

## Configuration

Redis connection details are supplied via environment/secret configuration and are never committed to the repo or written to logs.
