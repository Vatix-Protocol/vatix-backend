# Load Scripts (k6)

k6 stubs for load/soak testing. These are separate from `scripts/load-test-orders.ts`
(the existing signed tsx load tool) — this directory holds k6-based stubs.

## ⚠️ Local use only

- Never point these at a staging or production URL.
- `order-placement-soak.js` refuses to run unless `BASE_URL` contains
  `localhost`, `127.0.0.1`, or `api` (the docker-compose service name).
- Run only against your local `docker-compose` stack.

## Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) installed locally (not bundled as a project dependency).
- The API running locally: `docker compose --profile api up` or `pnpm dev`.
- At least one `ACTIVE` market (`pnpm prisma:seed`), passed via `-e MARKET_ID=<id>`.

## Run

```bash
k6 run scripts/load/order-placement-soak.js
k6 run -e BASE_URL=http://localhost:3000 -e MARKET_ID=<id> scripts/load/order-placement-soak.js
```

Target: 100 rps order placement against `POST /v1/orders` for a 30s soak window.

## Reading the results

The soak stub does not sign requests. Against an auth-enforcing or
tick-size-enforcing environment, every request is expected to be rejected with
a 4xx before reaching the matching engine. The k6 summary reports these as
separate named checks:

- `order accepted (2xx)` — the meaningful success signal (order accepted).
- `order rejected (4xx)` — expected for an unauthenticated local run; shows the
  rejection rate.
- `order not server error (non-5xx)` — a 5xx response fails this check.

A run that is entirely rejected by validation/auth/admission control will show
`order accepted (2xx)` at 0% and `order rejected (4xx)` at 100% — that is a
rejection, not a clean result.
