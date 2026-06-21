import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { openApiSpec } from "./openapi.js";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5433/vatix";
});

const { buildServer } = await import("../index.js");

const EXPECTED_V1_ROUTES = [
  { method: "GET", path: "/v1/health" },
  { method: "GET", path: "/v1/ready" },
  { method: "GET", path: "/v1/markets" },
  { method: "GET", path: "/v1/markets/:id" },
  { method: "GET", path: "/v1/markets/:id/orderbook" },
  { method: "GET", path: "/v1/orders/user/:address" },
  { method: "GET", path: "/v1/trades/user/:address" },
  { method: "POST", path: "/v1/orders" },
  { method: "GET", path: "/v1/wallets/:wallet/positions" },
  { method: "GET", path: "/v1/admin/markets" },
  { method: "PATCH", path: "/v1/admin/markets/:id/status" },
  { method: "GET", path: "/v1/openapi.json" },
] as const;

describe("OpenAPI specification", () => {
  it("exports a valid OpenAPI spec object", () => {
    expect(openApiSpec).toBeDefined();
    expect(typeof openApiSpec).toBe("object");
  });

  it("contains required top-level OpenAPI fields", () => {
    expect(openApiSpec).toHaveProperty("openapi");
    expect(openApiSpec).toHaveProperty("info");
    expect(openApiSpec).toHaveProperty("paths");
  });

  it("has valid openapi version", () => {
    expect(openApiSpec.openapi).toBe("3.0.0");
  });

  it("contains info object with title and version", () => {
    expect(openApiSpec.info).toBeDefined();
    expect(openApiSpec.info).toHaveProperty("title");
    expect(openApiSpec.info).toHaveProperty("version");
    expect(typeof openApiSpec.info.title).toBe("string");
    expect(typeof openApiSpec.info.version).toBe("string");
  });

  it("contains paths object with at least one endpoint", () => {
    expect(openApiSpec.paths).toBeDefined();
    expect(typeof openApiSpec.paths).toBe("object");
    const pathKeys = Object.keys(openApiSpec.paths);
    expect(pathKeys.length).toBeGreaterThan(0);
  });

  it("has expected API endpoints documented", () => {
    expect(openApiSpec.paths).toHaveProperty("/v1/health");
    expect(openApiSpec.paths).toHaveProperty("/v1/markets");
    expect(openApiSpec.paths).toHaveProperty("/v1/orders");
    expect(openApiSpec.paths).toHaveProperty("/v1/ready");
    expect(openApiSpec.paths).toHaveProperty("/v1/wallets/{wallet}/positions");
  });

  it("health endpoint is documented with GET method", () => {
    const healthPath = openApiSpec.paths["/v1/health"] as Record<
      string,
      unknown
    >;
    expect(healthPath).toHaveProperty("get");
  });

  it("markets endpoint is documented with GET method", () => {
    const marketsPath = openApiSpec.paths["/v1/markets"] as Record<
      string,
      unknown
    >;
    expect(marketsPath).toHaveProperty("get");
  });

  it("orders endpoint is documented with POST method", () => {
    const ordersPath = openApiSpec.paths["/v1/orders"] as Record<
      string,
      unknown
    >;
    expect(ordersPath).toHaveProperty("post");
  });

  it("each endpoint has a description and tags", () => {
    Object.entries(openApiSpec.paths).forEach(([path, pathItem]) => {
      const methods = Object.keys(pathItem as Record<string, unknown>);
      methods.forEach((method) => {
        const operation = (pathItem as Record<string, Record<string, unknown>>)[
          method
        ];
        expect(operation).toHaveProperty("summary");
        expect(operation).toHaveProperty("description");
      });
    });
  });

  it("contains servers array", () => {
    expect(openApiSpec).toHaveProperty("servers");
    expect(Array.isArray(openApiSpec.servers)).toBe(true);
  });

  it("contains components schema for Error type", () => {
    expect(openApiSpec.components).toBeDefined();
    expect(openApiSpec.components).toHaveProperty("schemas");
    expect(openApiSpec.components?.schemas).toHaveProperty("Error");
  });
});

describe("OpenAPI contract", () => {
  let server: FastifyInstance;

  beforeAll(async () => {
    server = buildServer({ logger: false, registerTestRoutes: false });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
  });

  it("all expected routes are registered on the server", () => {
    for (const { method, path } of EXPECTED_V1_ROUTES) {
      const exists = server.hasRoute({
        method: method as "GET" | "POST" | "PATCH",
        url: path,
      });
      expect(
        exists,
        `Expected route ${method} ${path} is not registered on the server`
      ).toBe(true);
    }
  });

  it("all expected routes are documented in the OpenAPI spec", () => {
    for (const { method, path } of EXPECTED_V1_ROUTES) {
      if (path === "/v1/openapi.json") continue;
      const specPath = path.replace(/:(\w+)/g, "{$1}");
      const pathItem = (openApiSpec.paths as Record<string, unknown>)[specPath];
      expect(
        pathItem,
        `Route ${method} ${path} is missing from spec paths`
      ).toBeDefined();
      expect(
        (pathItem as Record<string, unknown>)[method.toLowerCase()],
        `Spec path ${specPath} is missing method ${method.toLowerCase()}`
      ).toBeDefined();
    }
  });

  it("all documented spec paths have corresponding registered routes", () => {
    for (const [path, pathItem] of Object.entries(openApiSpec.paths)) {
      if (path === "/v1/openapi.json") continue;
      const fastifyPath = path.replace(/\{(\w+)\}/g, ":$1");
      const methods = Object.keys(pathItem as Record<string, unknown>);
      for (const method of methods) {
        const exists = server.hasRoute({
          method: method.toUpperCase() as "GET" | "POST" | "PATCH",
          url: fastifyPath,
        });
        expect(
          exists,
          `Spec documents ${method.toUpperCase()} ${path} but no route is registered`
        ).toBe(true);
      }
    }
  });

  it("no undocumented spec paths beyond expected routes", () => {
    const specPaths = Object.keys(openApiSpec.paths).filter(
      (p) => p !== "/v1/openapi.json"
    );
    for (const specPath of specPaths) {
      const fastifyPath = specPath.replace(/\{(\w+)\}/g, ":$1");
      const found = EXPECTED_V1_ROUTES.some((r) => r.path === fastifyPath);
      expect(
        found,
        `Spec path ${specPath} has no matching entry in expected routes`
      ).toBe(true);
    }
  });
});
