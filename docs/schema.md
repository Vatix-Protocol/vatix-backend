# Database Schema

The source of truth is `prisma/schema.prisma`; every change ships with a
migration under `prisma/migrations/`.

## `order_idempotency_keys` (`OrderIdempotencyKey`)

Idempotency ledger for `POST /v1/orders`. One row per `(signer, Idempotency-Key)`,
written in the same transaction as the order it created, so a replayed or
concurrent request with the same key can never place a second order. See
[orders-route.md](orders-route.md#idempotency).

| Column            | Type           | Notes                                                               |
| ----------------- | -------------- | ------------------------------------------------------------------- |
| `user_address`    | `VARCHAR(56)`  | Signing wallet. Part of the primary key, so keys are per wallet.    |
| `idempotency_key` | `VARCHAR(128)` | Client `Idempotency-Key` header. Part of the primary key.           |
| `request_hash`    | `VARCHAR(64)`  | SHA-256 of the canonical order payload the key was first used with. |
| `order_id`        | `TEXT`         | Unique; FK to `orders.id`, `ON DELETE CASCADE`.                     |
| `response`        | `JSONB`        | Original `201` response body, returned verbatim on replay.          |
| `created_at`      | `TIMESTAMP(3)` | Indexed, for age-based pruning.                                     |

- Primary key: `(user_address, idempotency_key)`.
- A reused key whose `request_hash` differs is rejected with `409 IDEMPOTENCY_CONFLICT`.
- Migration: `20260928000000_add_order_idempotency_keys` (additive; rolling back
  only requires dropping the table).
