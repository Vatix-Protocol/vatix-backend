# Soft-Deleted Markets

This document defines the invariants and the admin restore path for
soft-deleted markets in `vatix-backend`.

## Definitions

- **Soft-delete**: a market is marked as deleted but its row and history are
  retained. Soft-deleted markets are hidden from public listings and cannot be
  traded, but they can be restored by an authorized admin.
- **Hard-delete**: a market row is permanently removed. Hard-deleted markets
  are **not** recoverable and must never be resurrected by the restore path.
- **Unknown market**: an id that has never existed. The restore path must treat
  unknown ids the same as hard-deleted ids: fail closed, no side effects.

## Invariants

1. **Restore only restores.** The admin restore entrypoint may only transition a
   market from `soft_deleted` to `active`. It must never create a market, never
   change a market that is already `active`, and never touch a hard-deleted or
   unknown id.
2. **No resurrection.** Hard-deleted and unknown markets are terminal. Restore
   returns a stable error and performs no writes.
3. **Idempotent.** Replaying a restore for a market that is already `active`
   (including concurrent/replayed requests) must not double-apply, must not
   corrupt state, and must return a success-shaped result that is safe to retry.
4. **Deny by default.** Restore is a privileged surface. Untrusted clients,
   wrong roles, and expired auth must fail closed before any state change.
5. **Fail closed on dependency outage.** If the DB (or any required dependency)
   is unavailable, restore must not partially apply. Writes are atomic.
6. **Observable, no secrets.** Restore emits metrics/logs with a correlation id
   and stable error codes. Logs must never contain secrets or credentials.

## Admin restore entrypoint

`POST /admin/markets/:id/restore`

- **Authz**: requires an authenticated admin role. Deny-by-default; missing,
  expired, or non-admin credentials are rejected before any lookup or write.
- **Correlation id**: every response (success or error) includes a
  `correlationId` for tracing.
- **Idempotency**: safe to retry. A restore of an already-active market is a
  no-op success.

### Stable error codes

| Code | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | Missing or expired credentials. |
| `FORBIDDEN` | Authenticated but not an admin. |
| `MARKET_NOT_FOUND` | Unknown or hard-deleted market id. No resurrection. |
| `MARKET_NOT_SOFT_DELETED` | Market exists but is not in `soft_deleted` state. |
| `DEPENDENCY_UNAVAILABLE` | Required dependency (DB/Redis/RPC) is down; write failed closed. |

## Edge cases & failure modes

- **Concurrent/replayed requests**: guarded by the idempotency invariant; the
  transition is applied at most once.
- **Dependency outage**: writes fail closed with `DEPENDENCY_UNAVAILABLE`; no
  partial state.
- **Auth expiry / wrong role**: rejected with `UNAUTHENTICATED` / `FORBIDDEN`.
- **Adversarial input**: unknown ids and malformed ids are rejected without
  leaking whether a market exists beyond the documented error codes.
- **Testnet vs mainnet / address drift**: restore operates on the server-side
  market record, which remains the source of truth; it does not trust
  client-supplied addresses.

## Security considerations

- The server remains the source of truth for market state and admin actions.
- No secrets in repo or logs.
- Every external entrypoint is authorized and rate-limited.
- New privileged surfaces are deny-by-default.

## Rollback / kill-switch

Restore is a money-path-adjacent admin action. It must be gated behind a
feature flag / kill-switch so it can be disabled without a deploy. Document the
rollback procedure in the PR description when landing changes to this path.

## References

- `docs/SOFT_DELETED_MARKETS.md` (this document)
