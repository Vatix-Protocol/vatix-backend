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
