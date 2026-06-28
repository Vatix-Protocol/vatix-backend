# Chaos Testing

## Overview

`tests/integration/chaos-cross-contract.test.ts` implements a chaos-style harness
that issues a randomised sequence of valid cross-contract operations against live
running infrastructure (real Postgres + in-process Fastify) to surface ordering-
dependent bugs that deterministic tests miss.

The operations map to the four StellarSwipe-Contract interaction types:

| Chaos label      | Backend operation                                        |
| ---------------- | -------------------------------------------------------- |
| `stake`          | POST /v1/orders — resting BUY at sub-crossing price     |
| `signal_submit`  | POST /v1/orders — another resting BUY (different price) |
| `trade_execute`  | POST /v1/orders — crossing BUY that matches a SELL      |
| `fee_collect`    | GET /v1/wallets/:wallet/positions                        |

## Invariants Checked

1. **No panics** — every response has an HTTP status code below 500.
2. **Net-zero shares** — after all operations, the sum of `yes_shares` (and `no_shares`)
   across all `UserPosition` rows for a given market equals zero, because every matched
   trade credits the buyer and debits the seller by the same quantity.

## Running the Chaos Test

```bash
# Default seed (42)
pnpm vitest run --config vitest.integration.config.ts tests/integration/chaos-cross-contract.test.ts

# Custom seed
CHAOS_SEED=1234 pnpm vitest run --config vitest.integration.config.ts tests/integration/chaos-cross-contract.test.ts
```

## Reproducing a Specific Seed

If the chaos test surfaces a failure, the seed is printed in every assertion
message, e.g.:

```
AssertionError: Net YES shares for market <id> must be 0 (seed=99)
```

Reproduce by running with the exact seed:

```bash
CHAOS_SEED=99 pnpm vitest run --config vitest.integration.config.ts \
  tests/integration/chaos-cross-contract.test.ts
```

To lock the failure in as a regression case, add a dedicated test that sets
`CHAOS_SEED` programmatically:

```typescript
it("regression: seed 99 — net-zero shares violated", async () => {
  process.env.CHAOS_SEED = "99";
  // ... run the chaos harness logic inline with that seed
});
```

## Tuneable Parameters

| Variable          | Default | Description                                     |
| ----------------- | ------- | ----------------------------------------------- |
| `CHAOS_SEED`      | `42`    | Integer seed for the mulberry32 PRNG            |
| `OPERATION_COUNT` | `40`    | Number of randomised operations (in-source)     |

Increase `OPERATION_COUNT` for longer soak runs before a release cut.

## How the PRNG Works

The harness uses a mulberry32 seeded PRNG (not `Math.random()`) to ensure that
running the same seed produces exactly the same sequence of operations every
time, regardless of platform or JS engine version.
