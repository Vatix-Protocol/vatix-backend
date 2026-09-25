// k6 stub — order placement soak test (#807, ties to #730)
//
// ⚠️  LOCAL USE ONLY. Do NOT point this at a staging/production URL — see
// scripts/load/README.md. This is a stub: it exercises POST /v1/orders at a
// steady rate against the local docker-compose stack. It does not yet sign
// requests with a real Stellar keypair (see scripts/load-test-orders.ts for
// that flow) — fill in AUTH_HEADER / MARKET_ID before running against an
// environment that enforces auth.
//
// Run:
//   k6 run scripts/load/order-placement-soak.js
//   k6 run -e BASE_URL=http://localhost:3000 -e MARKET_ID=<id> scripts/load/order-placement-soak.js

import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const MARKET_ID = __ENV.MARKET_ID || "";
const AUTH_HEADER = __ENV.AUTH_HEADER || "";

// Guardrail: refuse anything that isn't clearly a local target.
const ALLOWED_HOSTS = ["localhost", "127.0.0.1", "api"];
if (!ALLOWED_HOSTS.some((h) => BASE_URL.includes(h))) {
  throw new Error(
    `Refusing to run against non-local BASE_URL="${BASE_URL}". ` +
      `This script is for local soak testing only — see scripts/load/README.md.`
  );
}

export const options = {
  scenarios: {
    order_placement_soak: {
      executor: "constant-arrival-rate",
      rate: 100, // target: 100 rps
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
};

export default function () {
  const side = Math.random() < 0.5 ? "BUY" : "SELL";
  const payload = JSON.stringify({
    marketId: MARKET_ID,
    outcome: "YES",
    side,
    price: 0.5,
    quantity: 10,
  });

  const headers = { "Content-Type": "application/json" };
  if (AUTH_HEADER) headers["Authorization"] = AUTH_HEADER;

  const res = http.post(`${BASE_URL}/v1/orders`, payload, { headers });

  check(res, {
    "status is not 5xx": (r) => r.status < 500,
  });

  sleep(0.01);
}
