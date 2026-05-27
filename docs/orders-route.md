# Orders Route

The orders route lets clients create market orders and fetch a wallet's order
history. Routes are implemented in `src/api/routes/orders.ts`.

## `GET /orders/user/:address`

Returns orders submitted by a Stellar wallet, sorted newest first.

### Request

Path parameters:

| Field     | Type   | Required | Description              |
| --------- | ------ | -------- | ------------------------ |
| `address` | string | yes      | Stellar public key to query. |

Query parameters:

| Field    | Type   | Required | Description |
| -------- | ------ | -------- | ----------- |
| `status` | string | no       | One of `OPEN`, `FILLED`, `CANCELLED`, or `PARTIALLY_FILLED`. |
| `page`   | number | no       | Page number, minimum `1`. Defaults to `1`. |
| `limit`  | number | no       | Page size, from `1` to `100`. Defaults to `20`. |

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

| Status | Cause |
| ------ | ----- |
| `400`  | Invalid Stellar address, status, page, or limit. |
| `500`  | Database lookup failed. |

## `POST /orders`

Creates a new order after validating the wallet address, market state, price,
quantity, side, and outcome.

### Request

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

| Field         | Type   | Required | Description |
| ------------- | ------ | -------- | ----------- |
| `marketId`    | string | yes      | Market to place the order on. |
| `userAddress` | string | yes      | Stellar public key submitting the order. |
| `side`        | string | yes      | `BUY` or `SELL`. |
| `outcome`     | string | yes      | `YES` or `NO`. |
| `price`       | number | yes      | Greater than `0` and less than `1`. |
| `quantity`    | number | yes      | Integer greater than or equal to `1`. |

### Response

Success returns HTTP `201`.

```json
{
  "success": true,
  "data": {
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
    }
  },
  "requestId": "7fd69c48-8c45-4b3f-9d23-55d542e6ab2f",
  "timestamp": "2026-01-20T00:00:00.000Z"
}
```

Common errors:

| Status | Cause |
| ------ | ----- |
| `400`  | Missing field, invalid Stellar address, invalid side/outcome, invalid price or quantity, unknown market, closed market, or expired market. |
| `500`  | Database write failed. |
