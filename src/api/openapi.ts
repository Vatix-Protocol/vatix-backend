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
        summary: "Readiness check",
        description: "Returns the readiness status including dependency health",
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
            description: "Market details",
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
    "/v1/orders": {
      post: {
        summary: "Create an order",
        description: "Submit a new order to the prediction market",
        tags: ["Orders"],
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
                  marketId: {
                    type: "string",
                  },
                  userAddress: {
                    type: "string",
                  },
                  side: {
                    type: "string",
                    enum: ["BUY", "SELL"],
                  },
                  outcome: {
                    type: "string",
                    enum: ["YES", "NO"],
                  },
                  price: {
                    type: "number",
                    minimum: 0,
                    maximum: 1,
                  },
                  quantity: {
                    type: "integer",
                    minimum: 1,
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Order created",
          },
          "400": {
            description: "Invalid request",
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
    "/v1/admin/markets": {
      get: {
        summary: "Admin market listing",
        description: "List markets for admin users",
        tags: ["Admin"],
        responses: {
          "200": {
            description: "Admin market list",
          },
        },
      },
    },
    "/v1/admin/markets/{id}/status": {
      patch: {
        summary: "Update market status",
        description: "Admin endpoint to change market status",
        tags: ["Admin"],
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
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
        },
      },
    },
  },
  components: {
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
