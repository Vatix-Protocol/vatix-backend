# Orders Route

The orders route lets clients create market orders and fetch a wallet's order
history. Routes are implemented in `src/api/routes/orders.ts`.

All public paths are mounted under `/v1`. Legacy root aliases redirect with
deprecation headers during the compatibility window.

## `GET /v1/orders/user/:address`

Returns orders submitted by a Stellar wallet, sorted newest first.

### Request

Path parameters:

| Field     | Type   | Required | Description                  |
| --------- | ------ | -------- | ---------------------------- |
| `address` | string | yes      | Stellar public key to query. |

Query parameters:

| Field    | Type   | Required | Description                                                  |
| -------- | ------ | -------- | ------------------------------------------------------------ |
| `status` | string | no       | One of `OPEN`, `FILLED`, `CANCELLED`, or `PARTIALLY_FILLED`. |
| `page`   | number | no       | Page number, minimum `1`. Defaults to `1`.                   |
| `limit`  | number | no       | Page size, from `1` to `100`. Defaults to `20`.              |

### Response

```json
{
  "orders": [
    {
      "id": "order-123",
      "marketId": "market-1",
      "userAddress": "G...",
      "side": "BUY",
      "outcome": "YES",
      "price": "0.6",
      "quantity": 100,
      "filledQuantity": 0,
      "status": "OPEN",
      "createdAt": "2026-01-20T00:00:00.000Z"
    }
  ],
  "total": 1,
  "hasNext": false,
  "page": 1,
  "limit": 20
}
```

Common errors:

| Status | Cause                                            |
| ------ | ------------------------------------------------ |
| `400`  | Invalid Stellar address, status, page, or limit. |
| `500`  | Database lookup failed.                          |

## `POST /v1/orders`

Creates a new order after validating wallet ownership via Ed25519 signature,
then checking the market state, price, quantity, side, and outcome.

### Authentication

Every `POST /v1/orders` request must carry three headers that prove the caller
controls the Stellar wallet identified by `userAddress`.

| Header        | Type   | Description                                                            |
| ------------- | ------ | ---------------------------------------------------------------------- |
| `x-timestamp` | string | Current Unix time in **milliseconds** as a decimal string.             |
| `x-nonce`     | string | Single-use nonce from `POST /v1/auth/challenge`.                       |
| `x-signature` | string | Base64-encoded Ed25519 signature of the canonical message (see below). |

The server rejects requests whose `x-timestamp` differs from server time by
more than **5 minutes**, and consumes `x-nonce` atomically from shared Redis so
the same signed payload cannot be replayed against another API replica. See
[adr/002-stellar-auth-challenge.md](adr/002-stellar-auth-challenge.md).

#### Challenge issuance

```http
POST /v1/auth/challenge
{ "userAddress": "G..." }

201 { "nonce": "...", "expiresAt": "2026-01-01T00:02:00.000Z", "ttlSeconds": 120 }
```

#### Canonical message

Build the UTF-8 JSON string with the following keys in **alphabetical order**
and sign its raw bytes with the wallet's Ed25519 private key:

```json
{
  "marketId": "<marketId from body>",
  "nonce": "<x-nonce value>",
  "outcome": "<outcome from body>",
  "price": <price from body>,
  "quantity": <quantity from body>,
  "side": "<side from body>",
  "timestamp": <x-timestamp value as number>,
  "userAddress": "<userAddress from body>"
}
```

#### Example (TypeScript / `@stellar/stellar-sdk`)

```typescript
import { Keypair } from "@stellar/stellar-sdk";
import { buildSignableMessage } from "src/api/middleware/stellarAuth";

const keypair = Keypair.fromSecret("S...");
const timestamp = Date.now();

const challenge = await fetch("/v1/auth/challenge", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ userAddress: keypair.publicKey() }),
}).then((res) => res.json());

const body = {
  marketId: "market-1",
  userAddress: keypair.publicKey(),
  side: "BUY",
  outcome: "YES",
  price: 0.6,
  quantity: 100,
};

const message = buildSignableMessage({
  ...body,
  nonce: challenge.nonce,
  timestamp,
});
const signature = keypair.sign(message).toString("base64");

fetch("/v1/orders", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-timestamp": String(timestamp),
    "x-nonce": challenge.nonce,
    "x-signature": signature,
  },
  body: JSON.stringify(body),
});
```

### Request body

```json
{
  "marketId": "market-1",
  "userAddress": "G...",
  "side": "BUY",
  "outcome": "YES",
  "price": 0.6,
  "quantity": 100
}
```

Fields:

| Field         | Type   | Required | Description                              |
| ------------- | ------ | -------- | ---------------------------------------- |
| `marketId`    | string | yes      | Market to place the order on.            |
| `userAddress` | string | yes      | Stellar public key submitting the order. |
| `side`        | string | yes      | `BUY` or `SELL`.                         |
| `outcome`     | string | yes      | `YES` or `NO`.                           |
| `price`       | number | yes      | Greater than `0` and less than `1`.      |
| `quantity`    | number | yes      | Integer greater than or equal to `1`.    |

### Response

Success returns HTTP `201`.

```json
{
  "order": {
    "id": "order-123",
    "marketId": "market-1",
    "userAddress": "G...",
    "side": "BUY",
    "outcome": "YES",
    "price": "0.6",
    "quantity": 100,
    "filledQuantity": 0,
    "status": "OPEN",
    "createdAt": "2026-01-20T00:00:00.000Z"
  },
  "trades": [],
  "filledQuantity": 0
}
```

Common errors:

| Status | Cause                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `400`  | Missing field, invalid Stellar address, invalid side/outcome, invalid price or quantity, unknown market, closed market, or expired market. |
| `401`  | Missing or invalid `x-signature`/`x-timestamp`/`x-nonce` headers, expired timestamp, reused or expired nonce, or signature mismatch.       |
| `500`  | Database write failed.                                                                                                                     |

## `GET /v1/trades/user/:address`

Returns trade history for a Stellar wallet.

Query parameters:

| Field      | Type   | Required | Description                                     |
| ---------- | ------ | -------- | ----------------------------------------------- |
| `page`     | number | no       | Page number, minimum `1`. Defaults to `1`.      |
| `limit`    | number | no       | Page size, from `1` to `100`. Defaults to `20`. |
| `from`     | string | no       | Inclusive UTC ISO-8601 start timestamp.         |
| `to`       | string | no       | Inclusive UTC ISO-8601 end timestamp.           |
| `marketId` | string | no       | Restrict results to one market.                 |
