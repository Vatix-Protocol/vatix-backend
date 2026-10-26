// k6 soak stub: order placement against POST /v1/orders.
//
// ⚠️ Local use only. Refuses to run unless BASE_URL looks local.
//
// This stub does NOT sign requests. Against an auth-enforcing or
// tick-size-enforcing environment, every request is expected to be rejected
// with a 4xx (validation/auth/admission control) before reaching the matching
// engine. For an unauthenticated local run:
//   - 2xx responses are the meaningful success signal (order accepted).
//   - 4xx responses are expected and are reported as a separate "rejected"
//     check so the k6 summary shows the rejection rate.
//   - 5xx responses are always a failure.
// Signing logic is intentionally out of scope for this stub.

import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const MARKET_ID = __ENV.MARKET_ID;
const AUTH_HEADER = __ENV.AUTH_HEADER || '';

const rejectionTrend = new Trend('order_rejections', true);

const LOCAL_HOSTS = ['localhost', '127.0.0.1', 'api'];

if (!LOCAL_HOSTS.some((host) => BASE_URL.includes(host))) {
  throw new Error(
    `Refusing to run: BASE_URL (${BASE_URL}) does not look local. ` +
      'This soak stub is for local use only.',
  );
}

if (!MARKET_ID) {
  throw new Error(
    `MARKET_ID is required. Provide it with: ` +
      `k6 run -e MARKET_ID=<id> scripts/load/order-placement-soak.js`,
  );
}

if (!AUTH_HEADER) {
  console.warn(
    '[order-placement-soak] AUTH_HEADER is not set — running unauthenticated. ' +
      'Provide it with: k6 run -e AUTH_HEADER=<token> ... if the target enforces auth.',
  );
}
}

export const options = {
  scenarios: {
    order_placement: {
      executor: 'constant-arrival-rate',
      rate: 100,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
  },
};

const payload = JSON.stringify({
  marketId: MARKET_ID,
  outcome: 'YES',
  price: 0.5,
  quantity: 10,
});

const params = {
  headers: {
    'Content-Type': 'application/json',
    ...(AUTH_HEADER ? { Authorization: AUTH_HEADER } : {}),
  },
};

export default function () {
  const r = http.post(`${BASE_URL}/v1/orders`, payload, params);

  check(r, {
    'order accepted (2xx)': (res) => res.status >= 200 && res.status < 300,
    'order rejected (4xx)': (res) => res.status >= 400 && res.status < 500,
    'order not server error (non-5xx)': (res) => res.status < 500,
  });

  if (r.status >= 400 && r.status < 500) {
    rejectionTrend.add(1);
  }
}
