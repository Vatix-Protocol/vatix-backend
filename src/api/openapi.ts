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
          },
          "503": {
            description: "Service is not ready",
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
        description: "Retrieve position exposures for a wallet",
        tags: ["Positions"],
        parameters: [
          {
            name: "wallet",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Wallet positions",
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
    },
  },
} as const;
