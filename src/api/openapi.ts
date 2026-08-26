/**
 * OpenAPI 3.0 specification for Vatix Backend API
 * Serves as a reference document for the API contract and can be used
 * by tools like Swagger UI or ReDoc for interactive documentation.
 */

export const openApiSpec = {
  openapi: "3.0.0",
  info: {
    title: "Vatix Backend API",
    description:
      "Backend API for the Vatix prediction market protocol on Stellar",
    version: "1.0.0",
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Development server",
    },
  ],
  paths: {
    "/v1/health": {
      get: {
        summary: "Health check",
        description: "Returns the health status of the API",
        tags: ["Health"],
        responses: {
          "200": {
            description: "Service is healthy",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: {
                      type: "string",
                      example: "ok",
                    },
                    service: {
                      type: "string",
                      example: "vatix-backend",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/ready": {
      get: {
        summary: "Readiness probe",
        description:
          "Reports whether the service can handle traffic. Checks database connectivity. Returns 503 when any critical dependency is unavailable.",
        tags: ["Health"],
        responses: {
          "200": {
            description: "Service is ready",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ready: { type: "boolean", example: true },
                    dependencies: {
                      type: "object",
                      properties: {
                        database: {
                          $ref: "#/components/schemas/DependencyResult",
                        },
                        indexFreshness: {
                          $ref: "#/components/schemas/DependencyResult",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          "503": {
            description: "Service is not ready",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ready: { type: "boolean", example: false },
                    dependencies: {
                      type: "object",
                      properties: {
                        database: {
                          $ref: "#/components/schemas/DependencyResult",
                        },
                        indexFreshness: {
                          $ref: "#/components/schemas/DependencyResult",
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/markets": {
      get: {
        summary: "List markets",
        description: "Retrieve a paginated list of prediction markets",
        tags: ["Markets"],
        parameters: [
          {
            name: "status",
            in: "query",
            description: "Filter by market status",
            schema: {
              type: "string",
              enum: ["ACTIVE", "RESOLVED", "CANCELLED"],
            },
          },
          {
            name: "limit",
            in: "query",
            description: "Number of markets to return",
            schema: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 50,
            },
          },
        ],
        responses: {
          "200": {
            description: "List of markets",
          },
        },
      },
    },
    "/v1/markets/{id}": {
      get: {
        summary: "Market details",
        description: "Retrieve a single market by ID",
        tags: ["Markets"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description:
              "Market details. Includes an ETag header identifying this " +
              "revision of the market — pass it back as If-Match on " +
              "PATCH /v1/admin/markets/{id}/status to guard against " +
              "concurrent updates.",
            headers: {
              ETag: {
                description: "Opaque version identifier for this market",
                schema: { type: "string" },
              },
            },
          },
          "404": {
            description: "Market not found",
          },
        },
      },
    },
    "/v1/markets/{id}/orderbook": {
      get: {
        summary: "Market orderbook",
        description: "Retrieve the orderbook for a market",
        tags: ["Markets"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Market orderbook",
          },
          "404": {
            description: "Market not found",
          },
        },
      },
    },
    "/v1/auth/challenge": {
      post: {
        summary: "Issue a signing challenge",
        description:
          "Returns a single-use nonce that must be included in the signed message and sent as the x-nonce header on the next mutating request. The nonce is stored in shared Redis with a TTL, so it is valid across API replicas exactly once.",
        tags: ["Auth"],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["userAddress"],
                properties: {
                  userAddress: {
                    type: "string",
                    description:
                      "Stellar public key (G...) requesting the challenge",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Challenge issued",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    nonce: { type: "string" },
                    expiresAt: { type: "string", format: "date-time" },
                    ttlSeconds: { type: "integer" },
                  },
                },
              },
            },
          },
          "401": { description: "Invalid userAddress" },
        },
      },
    },
    "/v1/orders": {
      post: {
        summary: "Create an order",
        description:
          "Submit a new order to the prediction market. Requires Stellar wallet ownership proof via Ed25519 signature headers.",
        tags: ["Orders"],
        parameters: [
          {
            name: "x-signature",
            in: "header",
            required: true,
            description:
              "Base64-encoded Ed25519 signature of the canonical request body JSON (keys sorted alphabetically) combined with x-timestamp, signed by the private key of userAddress.",
            schema: { type: "string" },
          },
          {
            name: "x-timestamp",
            in: "header",
            required: true,
            description:
              "Unix timestamp in milliseconds (string). Must be within ±5 minutes of server time to prevent replay attacks.",
            schema: { type: "string" },
          },
          {
            name: "x-nonce",
            in: "header",
            required: true,
            description:
              "Single-use nonce obtained from POST /v1/auth/challenge and included in the signed message. Consumed atomically in shared Redis, so a captured request cannot be replayed against another API replica.",
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "marketId",
                  "userAddress",
                  "side",
                  "outcome",
                  "price",
                  "quantity",
                ],
                properties: {
                  marketId: { type: "string" },
                  userAddress: { type: "string" },
                  side: { type: "string", enum: ["BUY", "SELL"] },
                  outcome: { type: "string", enum: ["YES", "NO"] },
                  price: { type: "number", minimum: 0, maximum: 1 },
                  quantity: { type: "integer", minimum: 1 },
                },
              },
              examples: {
                buyYes: {
                  summary: "Buy YES outcome",
                  value: {
                    marketId: "mkt_01j9z3k4p2q8r5t6u7v8w9x0y1",
                    userAddress:
                      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
                    side: "BUY",
                    outcome: "YES",
                    price: 0.65,
                    quantity: 100,
                  },
                },
                sellNo: {
                  summary: "Sell NO outcome",
                  value: {
                    marketId: "mkt_01j9z3k4p2q8r5t6u7v8w9x0y1",
                    userAddress:
                      "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
                    side: "SELL",
                    outcome: "NO",
                    price: 0.35,
                    quantity: 50,
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Order created",
            content: {
              "application/json": {
                examples: {
                  success: {
                    summary: "Order placed successfully",
                    value: {
                      success: true,
                      data: {
                        orderId: "ord_01j9z3k4p2q8r5t6u7v8w9x0y1",
                        status: "OPEN",
                      },
                      requestId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
                      timestamp: "2026-07-24T10:00:00.000Z",
                    },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid request",
            content: {
              "application/json": {
                examples: {
                  missingField: {
                    summary: "Missing required field",
                    value: {
                      code: "validation_error",
                      message: "marketId is required",
                      statusCode: 400,
                    },
                  },
                  priceOutOfRange: {
                    summary: "Price out of [0,1] range",
                    value: {
                      code: "validation_error",
                      message: "price must be between 0 and 1",
                      statusCode: 400,
                    },
                  },
                },
              },
            },
          },
          "401": {
            description: "Missing or invalid API key",
            content: {
              "application/json": {
                examples: {
                  unauthorized: {
                    summary: "No API key provided",
                    value: {
                      error: "Missing API key",
                      code: "UNAUTHORIZED",
                      statusCode: 401,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1/wallet/accounts/{accountId}": {
      get: {
        summary: "Get cached Horizon account",
        description:
          "Returns a briefly-cached Stellar Horizon account record for wallet, payment, and custody flows. Requires API key authentication.",
        tags: ["Wallet"],
        security: [{ apiKey: [] }],
        parameters: [
          {
            name: "accountId",
            in: "path",
            required: true,
            description: "Stellar public key (G…, 56 characters)",
            schema: { type: "string", pattern: "^G[A-Z2-7]{55}$" },
            examples: {
              valid: {
                summary: "Valid Stellar account",
                value:
                  "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
              },
            },
          },
        ],
        responses: {
          "200": {
            description: "Account data served from Horizon cache",
            content: {
              "application/json": {
                examples: {
                  hit: {
                    summary: "Cache hit — XLM account",
                    value: {
                      success: true,
                      data: {
                        account: {
                          accountId:
                            "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWNA",
                          sequence: "987654321",
                          balances: [
                            { asset_type: "native", balance: "250.0000000" },
                          ],
                          fetchedAt: 1753351200000,
                        },
                        source: "cache",
                      },
                      requestId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
                      timestamp: "2026-07-24T10:00:00.000Z",
                    },
                  },
                },
              },
            },
          },
          "400": {
            description: "Invalid request body or market not active",
          },
          "401": {
            description:
              "Missing, expired, or invalid x-signature / x-timestamp headers",
          },
        },
      },
    },
    "/v1/orders/{id}": {
      delete: {
        summary: "Cancel order",
        description: "Cancel an open order by ID",
        tags: ["Orders"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Order ID",
          },
        ],
        responses: {
          "200": {
            description: "Order cancelled successfully",
          },
          "400": {
            description: "Invalid order ID or order already filled/cancelled",
          },
          "404": {
            description: "Order not found",
          },
        },
      },
    },
    "/v1/orders/user/{address}": {
      get: {
        summary: "User orders",
        description: "Retrieve orders submitted by a user",
        tags: ["Orders"],
        parameters: [
          {
            name: "address",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "User orders",
          },
        },
      },
    },
    "/v1/trades": {
      get: {
        summary: "Trade listing",
        description:
          "Retrieve a Postgres-paginated listing of trades across all wallets, optionally filtered by market and time range. May be served from an optional Redis cache when TRADES_CACHE_ENABLED=true.",
        tags: ["Trades"],
        parameters: [
          {
            name: "page",
            in: "query",
            required: false,
            schema: { type: "integer", minimum: 1, default: 1 },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 20,
            },
          },
          {
            name: "marketId",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Filter trades by market identifier",
          },
          {
            name: "from",
            in: "query",
            required: false,
            schema: { type: "string", format: "date-time" },
            description: "Inclusive UTC start timestamp (ISO-8601)",
          },
          {
            name: "to",
            in: "query",
            required: false,
            schema: { type: "string", format: "date-time" },
            description: "Inclusive UTC end timestamp (ISO-8601)",
          },
        ],
        responses: {
          "200": {
            description: "Trade listing",
          },
        },
      },
    },
    "/v1/trades/user/{address}": {
      get: {
        summary: "User trade history",
        description: "Retrieve trade history for a wallet",
        tags: ["Trades"],
        parameters: [
          {
            name: "address",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "User trades",
          },
        },
      },
    },
    "/v1/wallets/{wallet}/positions": {
      get: {
        summary: "Wallet positions",
        description:
          "Retrieve position exposures for a wallet. Set includePnl=true to also compute realized/unrealized PnL (this is the canonical replacement for the deprecated /positions/user/:address endpoint).",
        tags: ["Positions"],
        parameters: [
          {
            name: "wallet",
            in: "path",
            required: true,
            schema: { type: "string" },
            description:
              "Stellar public key (StrKey): starts with G and is 56 chars using [A-Z2-7]",
          },
          {
            name: "includePnl",
            in: "query",
            required: false,
            schema: { type: "boolean", default: false },
            description:
              "When true, computes and includes realized/unrealized PnL per position and in the response summary.",
          },
        ],
        responses: {
          "200": {
            description: "Wallet positions",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WalletPositionsResponse",
                },
              },
            },
          },
        },
      },
    },
    "/v1/wallets/{wallet}/positions/{marketId}": {
      get: {
        summary: "Single market position",
        description:
          "Retrieve the position exposure for a wallet in a specific market. Returns 404 if no position exists.",
        tags: ["Positions"],
        parameters: [
          {
            name: "wallet",
            in: "path",
            required: true,
            schema: { type: "string" },
            description:
              "Stellar public key (StrKey): starts with G and is 56 chars using [A-Z2-7]",
          },
          {
            name: "marketId",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Market ID to fetch position for",
          },
        ],
        responses: {
          "200": {
            description: "Single market position",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    wallet: { type: "string" },
                    marketId: { type: "string" },
                    position: {
                      $ref: "#/components/schemas/WalletExposureRow",
                    },
                  },
                },
              },
            },
          },
          "404": {
            description: "No position found for the given wallet and market",
          },
        },
      },
    },
    "/v1/wallets/{wallet}/fills/stream": {
      get: {
        summary: "Order fill notifications (SSE)",
        description:
          "Server-Sent Events stream of order fill notifications for a wallet. " +
          "Emits a `connected` event on open, then an `order_fill` event for " +
          "each trade the wallet is party to as it settles. Only fills that " +
          "occur after the connection opens are sent — historical fills are " +
          "served by GET /v1/trades/user/{wallet}. The connection stays open " +
          "until the client disconnects.",
        tags: ["Orders"],
        // Marks this as a long-lived streaming endpoint so generic
        // reachability contract tests (which expect a response to
        // complete) skip it — see tests/contract/openapi-routes.test.ts.
        "x-streaming": true,
        parameters: [
          {
            name: "wallet",
            in: "path",
            required: true,
            schema: { type: "string" },
            description:
              "Stellar public key (StrKey): starts with G and is 56 chars using [A-Z2-7]",
          },
        ],
        responses: {
          "200": {
            description: "text/event-stream of order fill notifications",
            content: {
              "text/event-stream": {
                schema: { type: "string" },
              },
            },
          },
          "400": {
            description: "Invalid wallet address",
          },
        },
      },
    },
    "/v1/admin/markets": {
      get: {
        summary: "Admin market listing",
        description:
          "List all markets including CANCELLED ones. Requires API key and admin token.",
        tags: ["Admin"],
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        responses: {
          "200": {
            description: "Admin market list",
          },
          "401": {
            description: "Missing or invalid API key",
          },
          "403": {
            description: "Invalid admin token",
          },
        },
      },
    },
    "/v1/admin/markets/{id}/status": {
      patch: {
        summary: "Update market status",
        description:
          "Admin endpoint to change market status. Requires API key and admin token. " +
          "Supports optimistic concurrency: send If-Match with the ETag from GET " +
          "/v1/markets/{id} to reject the update with 412 if the market changed " +
          "since it was read.",
        tags: ["Admin"],
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "If-Match",
            in: "header",
            required: false,
            description:
              "ETag previously returned by GET /v1/markets/{id}. When provided " +
              "and it no longer matches the market's current ETag, the update " +
              "is rejected with 412 Precondition Failed.",
            schema: { type: "string" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["status"],
                properties: {
                  status: {
                    type: "string",
                    enum: ["ACTIVE", "RESOLVED", "CANCELLED"],
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Market updated",
          },
          "400": {
            description: "Invalid request",
          },
          "401": {
            description: "Missing or invalid API key",
          },
          "403": {
            description: "Invalid admin token",
          },
          "404": {
            description: "Market not found",
          },
          "412": {
            description:
              "If-Match header did not match the market's current ETag",
          },
        },
      },
    },
    "/v1/admin/analytics/summary": {
      get: {
        summary: "Admin analytics summary",
        description:
          "Aggregate market/trade reporting stats (market counts by status, " +
          "total trades, total traded quantity). Requires API key and admin " +
          "token. Reads from the analytics (read-only) database connection " +
          "when ANALYTICS_DATABASE_URL is configured, falling back to the " +
          "primary connection otherwise — see 'source' in the response.",
        tags: ["Admin"],
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        responses: {
          "200": {
            description: "Aggregate analytics summary",
          },
          "401": {
            description: "Missing or invalid API key",
          },
          "403": {
            description: "Invalid admin token",
          },
        },
      },
    },
    "/v1/admin/audit/verify-chain": {
      post: {
        summary: "Verify audit trail hash chain",
        description:
          "Verify hash chain integrity and detect tampering for a market's " +
          "audit trail. Requires API key and admin auth.",
        tags: ["Admin", "Audit"],
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["marketId"],
                properties: {
                  marketId: { type: "string" },
                  startTime: { type: "string", format: "date-time" },
                  endTime: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Chain verification result",
          },
          "400": {
            description: "Invalid request parameters",
          },
          "401": {
            description: "Missing or invalid API key",
          },
          "403": {
            description: "Invalid admin token",
          },
        },
      },
    },
    "/v1/admin/audit/watermark/{marketId}": {
      get: {
        summary: "Get audit archival watermark",
        description:
          "Get archival watermark for a market's audit trail. " +
          "Requires API key and admin auth.",
        tags: ["Admin", "Audit"],
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          {
            name: "marketId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Archival watermark",
          },
          "401": {
            description: "Missing or invalid API key",
          },
          "403": {
            description: "Invalid admin token",
          },
        },
      },
    },
    "/v1/admin/audit/events/{marketId}": {
      get: {
        summary: "Get archived audit events",
        description:
          "Get archived audit events for a market with pagination. " +
          "Requires API key and admin auth.",
        tags: ["Admin", "Audit"],
        security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        parameters: [
          {
            name: "marketId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
          {
            name: "limit",
            in: "query",
            description: "Max events per page (default 100, max 1000)",
            schema: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
          },
          {
            name: "offset",
            in: "query",
            description: "Skip N events (default 0)",
            schema: { type: "integer", minimum: 0, default: 0 },
          },
        ],
        responses: {
          "200": {
            description: "Paginated audit events",
          },
          "401": {
            description: "Missing or invalid API key",
          },
          "403": {
            description: "Invalid admin token",
          },
        },
      },
    },
    "/v1/wallets/{wallet}/fills/stream": {
      get: {
        summary: "Order fill notifications stream",
        description:
          "Server-Sent Events stream of order fill notifications for a wallet. " +
          "Only fills that occur after the client connects are pushed.",
        tags: ["Fills"],
        parameters: [
          {
            name: "wallet",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Wallet address",
          },
          {
            name: "after",
            in: "query",
            description:
              "Resume cursor (stream ID or ISO timestamp); fallback for " +
              "clients that cannot set Last-Event-ID header",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description:
              "Event stream of fills (Server-Sent Events; text/event-stream)",
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "API key required for all admin endpoints",
      },
      BearerAuth: {
        type: "http",
        scheme: "bearer",
        description: "Admin token required for all admin endpoints",
      },
    },
    schemas: {
      Error: {
        type: "object",
        properties: {
          code: {
            type: "string",
          },
          message: {
            type: "string",
          },
          statusCode: {
            type: "integer",
          },
          requestId: {
            type: "string",
          },
        },
      },
      DependencyResult: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["ok", "error", "stale"],
          },
          error: {
            type: "string",
            nullable: true,
          },
        },
      },
      WalletExposureRow: {
        type: "object",
        properties: {
          marketId: { type: "string" },
          marketQuestion: { type: "string" },
          yesShares: { type: "number" },
          noShares: { type: "number" },
          netExposure: { type: "number" },
          lockedCollateral: { type: "string" },
          isSettled: { type: "boolean" },
          updatedAt: { type: "string", format: "date-time" },
          pnlRealized: {
            type: ["string", "null"],
            description: "Present only when includePnl=true.",
          },
          pnlUnrealized: {
            type: ["string", "null"],
            description: "Present only when includePnl=true.",
          },
        },
      },
      WalletPositionsResponse: {
        type: "object",
        properties: {
          wallet: { type: "string" },
          exposures: {
            type: "array",
            items: { $ref: "#/components/schemas/WalletExposureRow" },
          },
          count: { type: "number" },
          pnlRealized: {
            type: "string",
            description: "Present only when includePnl=true.",
          },
          pnlUnrealized: {
            type: "string",
            description: "Present only when includePnl=true.",
          },
          pnlTotal: {
            type: "string",
            description: "Present only when includePnl=true.",
          },
        },
      },
    },
  },
} as const;

/**
 * Returns the OpenAPI spec served to clients. In production, paths tagged
 * "Admin" (internal-only endpoints) are stripped so they never appear in
 * the public /docs Swagger UI or /v1/openapi.json response — reducing the
 * discoverable surface area for internal admin routes (#805, ties to #741).
 * Non-production environments continue to see the full spec, including
 * Admin routes, for local/dev testing.
 */
export function getOpenApiSpec(nodeEnv: string): typeof openApiSpec {
  if (nodeEnv !== "production") {
    return openApiSpec;
  }

  const publicPaths = Object.fromEntries(
    Object.entries(openApiSpec.paths).filter(([, pathItem]) => {
      const operations = Object.values(pathItem) as Array<{
        tags?: readonly string[];
      }>;
      return !operations.some((op) => op?.tags?.includes("Admin"));
    })
  );

  return {
    ...openApiSpec,
    paths: publicPaths,
  } as typeof openApiSpec;
}
