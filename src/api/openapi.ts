/**
 * OpenAPI 3.0 specification for Vatix Backend API
 * Serves as a reference document for the API contract and can be used
 * by tools like Swagger UI or ReDoc for interactive documentation.
 */

import type { FastifyReply, FastifyRequest } from "fastify";

interface OpenApiStubBody {
  name: string;
}

function validateOpenApiStubBody(body: unknown): body is OpenApiStubBody {
  return (
    typeof body === "object" &&
    body !== null &&
    "name" in body &&
    typeof (body as { name?: unknown }).name === "string" &&
    (body as { name: string }).name.trim().length > 0
  );
}

export async function openApiStubHandler(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!validateOpenApiStubBody(request.body)) {
    return reply.status(400).send({
      error: "name is required",
    });
  }

  return reply.status(200).send({ ok: true });
}

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
    "/health": {
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
    "/readiness": {
      get: {
        summary: "Readiness check",
        description: "Returns the readiness status including dependency health",
        tags: ["Health"],
        responses: {
          "200": {
            description: "Service is ready",
          },
          "503": {
            description: "Service is not ready",
          },
        },
      },
    },
    "/markets": {
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
    "/orders": {
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
                    userAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
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
                    userAddress: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
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
                      data: { orderId: "ord_01j9z3k4p2q8r5t6u7v8w9x0y1", status: "OPEN" },
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
                    value: { error: "Missing API key", code: "UNAUTHORIZED", statusCode: 401 },
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
                value: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
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
                          accountId: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
                          sequence: "987654321",
                          balances: [{ asset_type: "native", balance: "250.0000000" }],
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
            description: "Invalid Stellar account ID format",
            content: {
              "application/json": {
                examples: {
                  invalid: {
                    summary: "Malformed account ID",
                    value: {
                      code: "validation_error",
                      message: "accountId must be a valid Stellar public key",
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
                    summary: "No API key",
                    value: { error: "Missing API key", code: "UNAUTHORIZED", statusCode: 401 },
                  },
                },
              },
            },
          },
          "404": {
            description: "Account not found in cache",
            content: {
              "application/json": {
                examples: {
                  miss: {
                    summary: "Cache miss",
                    value: {
                      code: "not_found",
                      message: "Account not found in cache: GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
                      statusCode: 404,
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
  components: {
    securitySchemes: {
      apiKey: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
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
    },
  },
} as const;
