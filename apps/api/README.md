# API Module

## Purpose

Houses all HTTP-facing logic (controllers, routes, middleware).

## Scope

- Request/response handling
- Input validation
- Routing layer only

## Ownership

Backend/API team

## Notes

No business logic should live here; delegate to services.

## Orders API (`apps/api/routes/orders.ts`)

### Authz (deny-by-default)

Every orders entrypoint is authenticated and authorized before any handler logic runs.
Untrusted clients cannot bypass policy:

- All routes require a valid session/JWT principal (`request.user`); missing or
  expired credentials fail closed with `401 ORDERS_UNAUTHORIZED`.
- The principal id must be a well-formed Stellar public key. A malformed
  identity is a `401`, never an anonymous fallback - this is the
  testnet/mainnet address-drift guard, and it is the value written to
  `Order.userAddress`.
- Privileged surfaces (create/cancel) require the `TRADER` or `ADMIN` role; any
  other role fails closed with `403 ORDERS_FORBIDDEN`. New privileged surfaces
  default to denied until an explicit role is added to `WRITE_ROLES`.
- **Reads are scoped too.** `GET /orders` and `GET /orders/:id` are not public:
  a non-admin only ever sees their own orders. The ownership filter is part of
  the Prisma `where` predicate (not a post-filter), so `total` and pagination
  cannot leak another trader's book. Reading somebody else's order answers
  `404`, not `403` - a `403` would confirm the order id exists.

### Validation & error codes

Requests and responses are typed and validated at the boundary. Every response

- success or failure - uses one envelope, `{ error: { code, message, correlationId } }`.
  Schema-level rejections are normalised into the same envelope so a caller never
  has to parse two different error shapes.

| Code                            | HTTP    | Meaning                                                                           |
| ------------------------------- | ------- | --------------------------------------------------------------------------------- |
| `ORDERS_UNAUTHORIZED`           | 401     | Missing/expired credentials, or a principal that is not a Stellar account         |
| `ORDERS_FORBIDDEN`              | 403     | Authenticated but wrong role, or not the order owner                              |
| `ORDERS_NOT_FOUND`              | 404     | Order does not exist, or is not visible to the caller                             |
| `ORDERS_MARKET_NOT_FOUND`       | 404     | Market does not exist **or is soft-deleted**                                      |
| `ORDERS_VALIDATION_FAILED`      | 400/413 | Malformed, out-of-range, or oversized payload                                     |
| `ORDERS_IDEMPOTENCY_CONFLICT`   | 409     | Replayed key with a different payload, or a filled order that cannot be cancelled |
| `ORDERS_RATE_LIMITED`           | 429     | Entrypoint rate limit exceeded (`Retry-After` is set)                             |
| `ORDERS_DEPENDENCY_UNAVAILABLE` | 503     | Orders store unavailable (writes fail closed)                                     |
| `ORDERS_INTERNAL_ERROR`         | 500     | Unexpected failure; the driver message is never surfaced                          |

Every response carries a correlation id (echoed from `x-correlation-id` or
generated) for tracing. A caller-supplied correlation id is only echoed when it
is short, printable, space-free ASCII - otherwise it is replaced, so it cannot
be used to forge log lines or inject header structure.

### Rate limiting

Every entrypoint is rate limited per client identity, and the identity prefers
the authenticated principal so an untrusted client cannot bypass the policy by
rotating source addresses. Mutating routes get a tighter budget than reads.

| Surface                                   | Limit       | Window |
| ----------------------------------------- | ----------- | ------ |
| `GET /orders`, `GET /orders/:id`          | 120 req/min | 60 s   |
| `POST /orders`, `POST /orders/:id/cancel` | 30 req/min  | 60 s   |

The in-memory window store evicts entries whose window has already reset, off
request volume (no timer to schedule or tear down). Without that, one entry per
client identity ever seen is retained for the lifetime of the process.

### Idempotency

Order writes accept an optional `idempotencyKey` (max 64 chars, stored in a
uniquely indexed nullable column). A replay never re-enters the market guard and
never writes:

- same key + same payload -> `200` with the original order;
- same key + different payload -> `409 ORDERS_IDEMPOTENCY_CONFLICT`;
- key already used by a _different_ principal -> `409` (never a replay, so one
  trader cannot probe another's keys or read their order);
- concurrent duplicates are resolved through the unique-constraint conflict
  path with the same replay/conflict rules, so a lost race is never a `500`.

Cancellation is naturally idempotent: replaying it returns the same terminal
state instead of failing, and cancels bump `Order.version` so a cancel racing a
match can never both win.

### Fail-closed writes

When a dependency (DB/Redis) is unavailable, writes are rejected with
`ORDERS_DEPENDENCY_UNAVAILABLE` rather than partially applied. Authorization runs
_before_ the store is touched, so a denied caller cannot probe availability.

### Soft-deleted markets

`POST /orders` applies the logic-level soft-delete pattern from
`docs/SOFT_DELETED_MARKETS.md`: the market is loaded and rejected with
`404 ORDERS_MARKET_NOT_FOUND` unless `deletedAt === null`. An unresolved
`deletedAt` (a projection that omits the column) is treated as deleted, so the
guard fails closed. A replayed idempotency key short-circuits before this check
and still returns `200`, so an already-accepted order is never orphaned by a
later soft delete. Historical orders stay readable to their owner for audit;
the market row itself is never re-exposed.

### Observability

Metrics and logs cover the money path (order create/cancel, authz denials,
idempotency hits/conflicts, dependency failures). Logs never include secrets,
tokens, or full credentials.

### Rollback / kill-switch

Money-path or mainnet-affecting changes land behind a feature flag with a
documented kill-switch and rollback steps in the PR description. The money-path
behaviour introduced with the idempotency key is additive: dropping the column
reverts to a world where every write is a fresh order, and no other behaviour
depends on it.

### Testing

- `apps/api/routes/orders.test.ts` - authz negatives (missing principal, wrong
  role, non-Stellar identity, cross-trader read/cancel), read scoping, rate
  limits, fail-closed writes, idempotency replay/conflict/concurrency,
  validation, correlation ids, and the soft-delete write guard.
