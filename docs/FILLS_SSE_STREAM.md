# Fills SSE Stream: Resume Tokens & Gap Detection

## Overview

The fills SSE (Server-Sent Events) stream provides real-time order fill notifications for a wallet. The stream is durable: clients can disconnect and reconnect without missing fills via resume tokens, and gap detection alerts clients when they've fallen too far behind.

## Endpoint

```
GET /v1/wallets/:wallet/fills/stream
```

### Response

- **Status**: 200 OK or 410 Gone
- **Content-Type**: `text/event-stream`
- **Cache-Control**: `no-cache`
- **Connection**: `keep-alive`

## Resume Tokens & Reconnection

### How it Works

1. **Server emits unique event ID** for each fill: `id: 1234567890000-0`
2. **Browser's native EventSource** captures the last received `id:` as `Last-Event-ID`
3. **On reconnect**, EventSource sends `Last-Event-ID: 1234567890000-0` header
4. **Server detects cursor**, replays missed fills, resumes from there

### Client Implementation (JavaScript)

```javascript
const wallet = "GAWBT2Z5...";
let lastReceivedId = localStorage.getItem("fillStreamId");

const eventSource = new EventSource(`/v1/wallets/${wallet}/fills/stream`, {
  headers: { "Last-Event-ID": lastReceivedId },
});

eventSource.addEventListener("order_fill", (event) => {
  const fill = JSON.parse(event.data);
  console.log("Fill received:", fill);

  // Browser automatically updates Last-Event-ID,
  // but you can also persist manually
  localStorage.setItem("fillStreamId", event.lastEventId);
});

eventSource.addEventListener("gap", (event) => {
  const gap = JSON.parse(event.data);
  console.warn("Stream gap detected:", gap);
  // Optionally: refresh from REST API or reconnect
});
```

### Query Parameter Fallback

If your client cannot set request headers (rare), use `?after=` query parameter:

```javascript
const isoTime = new Date(Date.now() - 30000).toISOString();
const url = `/v1/wallets/${wallet}/fills/stream?after=${encodeURIComponent(isoTime)}`;
const eventSource = new EventSource(url);
```

## Event Types

### `connected`

Emitted once on connection, contains stream metadata:

```json
{
  "event": "connected",
  "data": {
    "wallet": "GAWBT2Z5...",
    "cursor": "1234567890000-0",
    "minCursor": "1234567800000-0",
    "maxCursor": "1234567890000-0",
    "recordCount": 42
  },
  "id": "1234567890000-0"
}
```

**Fields**:

- `cursor`: Starting point for new fills (from Last-Event-ID or now)
- `minCursor`: Oldest available cursor (before this = trimmed, outside replay window)
- `maxCursor`: Newest available cursor
- `recordCount`: Total fills for this wallet

### `order_fill`

Emitted for each trade matching this wallet:

```json
{
  "event": "order_fill",
  "data": {
    "tradeId": "trade-uuid",
    "marketId": "market-uuid",
    "outcome": "YES",
    "side": "BUY",
    "orderId": "order-uuid",
    "counterpartyAddress": "GXYZ...",
    "price": 0.75,
    "quantity": 10,
    "tradedAt": "2026-07-29T12:30:45.123Z"
  },
  "id": "1234567890123-0"
}
```

**Fields**:

- `tradeId`: Unique trade ID (idempotency key for client deduplication)
- `side`: BUY if wallet is buyer, SELL if wallet is seller
- `orderId`: The wallet's order ID that matched
- `price`: Decimal price in [0, 1]
- `tradedAt`: ISO timestamp of trade execution

**Resume ID**: The `id:` field is the resume cursor; clients should store this for reconnection.

### `replay_start`

Emitted when server is replaying missed fills after a reconnect:

```json
{
  "event": "replay_start",
  "data": {
    "count": 5
  }
}
```

Followed by `count` `order_fill` events, then `replay_end`.

### `replay_end`

Marks end of replay phase:

```json
{
  "event": "replay_end",
  "data": {
    "replayed": 5
  }
}
```

After this event, subsequent `order_fill` events are real-time.

### `replay_error`

Emitted if replay fails:

```json
{
  "event": "replay_error",
  "data": {
    "message": "Failed to replay missed fills"
  }
}
```

Recommendations:

- Reconnect without Last-Event-ID to resume from now
- Or use REST `/trades/user/:address` to catch up manually

### heartbeat

Sent every 15 seconds (configurable via `HEARTBEAT_INTERVAL_MS`):

```
: heartbeat
```

This is a comment (not an event); it keeps intermediary proxies from closing idle connections. Ignore in client code.

## Gap Detection & 410 Response

### When Gaps Occur

Gaps are detected in two scenarios:

1. **Cursor Trimmed**: Last-Event-ID refers to a trade that's been trimmed from the replay buffer
   - Reason: `cursor_trimmed`
   - Suggested action: Use `suggestedCursor` to resume from oldest available

2. **Cursor Beyond Max Replay Window**: Last-Event-ID is too old (>10 min by default)
   - Reason: `beyond_max_window`
   - Suggested action: Use REST API or clear Last-Event-ID

3. **Cursor Unknown**: Last-Event-ID never existed
   - Reason: `cursor_unknown`
   - Suggested action: Reconnect without Last-Event-ID

### 410 Gone Response

```
HTTP/1.1 410 Gone
Content-Type: application/json

{
  "error": "stream_gap",
  "message": "Requested resume cursor is stale or has been trimmed from the stream.",
  "reason": "cursor_trimmed",
  "suggestedCursor": "1234567800000-0",
  "guidance": "Reconnect without Last-Event-ID to get current fills, or use suggestedCursor to catch up."
}
```

### Client Handling

```javascript
fetch(`/v1/wallets/${wallet}/fills/stream`, {
  headers: { "Last-Event-ID": staleId },
}).then((res) => {
  if (res.status === 410) {
    const gap = res.json();
    console.warn("Stream gap:", gap.reason);

    if (gap.suggestedCursor) {
      // Optionally: reconnect with suggested cursor
      connectWithCursor(gap.suggestedCursor);
    } else {
      // Otherwise: reconnect without cursor (fresh start)
      connectFresh();
    }
  }
});
```

## Replay Window & Configuration

### Default Configuration

```bash
# How often to poll database for new fills (ms)
ORDER_FILL_STREAM_POLL_MS=2000

# Max time to keep fills available for replay (ms, default 10 min)
FILLS_MAX_REPLAY_WINDOW_MS=600000

# Heartbeat interval (ms)
HEARTBEAT_INTERVAL_MS=15000
```

### Replay Window & Backfill Strategy

Replay window is backed by both Redis and Postgres for resilience:

1. **Live data (Redis stream)**: Recent fills (within Redis MAXLEN retention, typically minutes)
   - Fast, in-memory replay for recently disconnected clients
   
2. **Historical backfill (Postgres)**: All fills in Postgres (retention policy-dependent)
   - When a cursor is older than Redis retention, fills are backfilled from Postgres
   - Seamless splicing: Postgres history → Redis live data with no gaps

**Guarantees**:
- Clients reconnecting within 10 minutes (`FILLS_MAX_REPLAY_WINDOW_MS`) replay from Redis
- Clients reconnecting after Redis trim are backfilled from Postgres if data exists there
- Gap detection returns 410 *only* if Postgres also lacks the requested cursor
- No duplicate fills at the Redis/Postgres seam (sorted by `tradedAt`)

### Behavior Examples

| Scenario | Cursor Age | Redis | Postgres | Result |
|----------|------------|-------|----------|--------|
| Fresh client | N/A | - | - | Connect, stream from now |
| Recent disconnect | < 10min | ✓ | ✓ | Replay from Redis |
| Stale cursor | > 10min, in DB | ✗ | ✓ | Backfill from Postgres + resume |
| Very old cursor | Way old | ✗ | ✗ | 410 Gone (suggest oldest) |
| Corrupted cursor | Invalid | ✗ | ✗ | 410 Gone (cursor_unknown) |

## Idempotency & Deduplication

Fills are **NOT deduplicated by the server**. A reconnecting client may receive the same fill twice:

1. Once in the `replay_start`...`replay_end` phase
2. Once again if polling overlaps

**Client responsibility**: Deduplicate on `tradeId` before applying to local state.

```javascript
const seen = new Set(); // Store tradeId

eventSource.addEventListener("order_fill", (event) => {
  const fill = JSON.parse(event.data);

  if (seen.has(fill.tradeId)) {
    console.warn("Duplicate fill, skipping:", fill.tradeId);
    return;
  }

  seen.add(fill.tradeId);
  updateLocalPosition(fill);
});
```

## Load & Scaling

### Per-Wallet Polling

Each connected SSE client polls the database independently every `ORDER_FILL_STREAM_POLL_MS`. High concurrency can create database load.

**Optimization** (future): Multiplex multiple clients onto a single shared cursor using Redis pub/sub.

### Bounded Replay

Replay is limited to 100 fills by default. If a client disconnects for >10 min and >100 fills occur, they'll receive:

1. The first 100 missed fills (in `replay_*` events)
2. A recommendation to refresh from REST API or gap event

## Testing

### Integration Test Example

```typescript
// 1. Create test trades
await createTestTrade("trade1", wallet, counterparty, now);

// 2. Connect and capture event ID
const firstResponse = await fetch(`/v1/wallets/${wallet}/fills/stream`);
const eventId = firstResponse.body.match(/id: (\d+-\d+)/)?.[1];

// 3. Create another trade (while "disconnected")
await createTestTrade("trade2", wallet, counterparty, new Date());

// 4. Reconnect with Last-Event-ID
const secondResponse = await fetch(`/v1/wallets/${wallet}/fills/stream`, {
  headers: { "Last-Event-ID": eventId },
});

// 5. Assert replay of trade2
assert(secondResponse.body.includes("replay_start"));
assert(secondResponse.body.includes("trade2"));
```

## OpenAPI Spec

```yaml
/v1/wallets/{wallet}/fills/stream:
  get:
    summary: "Order fills SSE stream with resume tokens"
    parameters:
      - name: wallet
        in: path
        required: true
        schema:
          type: string
      - name: after
        in: query
        description: "Resume cursor (stream ID or ISO timestamp) if client cannot set Last-Event-ID header"
        schema:
          type: string
    responses:
      "200":
        description: "SSE stream established"
        headers:
          Content-Type:
            schema:
              type: string
              example: "text/event-stream"
      "410":
        description: "Cursor stale or trimmed; use suggestedCursor to resume"
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/StreamGap"
      "400":
        description: "Invalid wallet address"
```

## Troubleshooting

### Client Receives All Fills Again After Reconnect

**Cause**: Last-Event-ID not set correctly.

**Fix**: Ensure browser EventSource sends Last-Event-ID header, or manually set query parameter.

### Frequent 410 Responses

**Cause**: Replay window too short for your use case.

**Fix**: Increase `FILLS_MAX_REPLAY_WINDOW_MS` or have client use REST API as fallback.

### Duplicate Fills in UI

**Cause**: Client not deduplicating on `tradeId`.

**Fix**: Deduplicate based on `tradeId` before updating local state.

### Connection Stuck (No Heartbeats)

**Cause**: Proxy buffering or network issue.

**Fix**: Disable proxy buffering (nginx: `X-Accel-Buffering: no`). Already set in response headers.
