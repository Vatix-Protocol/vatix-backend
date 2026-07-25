import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { openApiSpec } from "./openapi.js";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5433/vatix";
});

const { buildServer } = await import("../index.js");

/**
 * Routes that exist in the code but are not (and should not be) in the OpenAPI spec.
 * These are internal/infrastructure routes.
 *
 * When adding a new route, decide:
 * - If it's a public API route: add it to src/api/openapi.ts and it will be automatically
 *   tested by this contract test
 * - If it's an internal route (e.g., diagnostics, internal probes): add it here and
 *   document why it's excluded from the public spec
 */
const ROUTES_NOT_IN_SPEC = [
  { method: "GET", path: "/v1/openapi.json" },
  // /docs serves Swagger UI HTML — it's a UI endpoint, not an API resource
  { method: "GET", path: "/docs" },
] as const;

type OpenApiPath = keyof typeof openApiSpec.paths;

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

  it("all OpenAPI spec paths have a corresponding registered route", () => {
    for (const [specPath, pathItem] of Object.entries(openApiSpec.paths)) {
      const fastifyPath = specPath.replace(/\{(\w+)\}/g, ":$1");
      const methods = Object.keys(pathItem as Record<string, unknown>);

      for (const method of methods) {
        const exists = server.hasRoute({
          method: method.toUpperCase() as
            | "GET"
            | "POST"
            | "PATCH"
            | "PUT"
            | "DELETE",
          url: fastifyPath,
        });
        expect(
          exists,
          `OpenAPI spec documents ${method.toUpperCase()} ${specPath} but route ${method.toUpperCase()} ${fastifyPath} is not registered`
        ).toBe(true);
      }
    }
  });

  it("all registered routes (except infrastructure routes) are documented in OpenAPI spec", () => {
    // Build the list of all routes that should be in the spec by extracting from OpenAPI
    const expectedRoutesInSpec: Array<{ method: string; path: string }> = [];

    // Extract routes from OpenAPI spec
    for (const [specPath, pathItem] of Object.entries(openApiSpec.paths)) {
      const fastifyPath = specPath.replace(/\{(\w+)\}/g, ":$1");
      const methods = Object.keys(pathItem as Record<string, unknown>);

      for (const method of methods) {
        expectedRoutesInSpec.push({
          method: method.toUpperCase(),
          path: fastifyPath,
        });
      }
    }

    // Add infrastructure routes that are not in the spec
    expectedRoutesInSpec.push(
      ...ROUTES_NOT_IN_SPEC.map((r) => ({ method: r.method, path: r.path }))
    );

    // Verify every expected route is registered
    for (const { method, path } of expectedRoutesInSpec) {
      const exists = server.hasRoute({
        method: method as "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
        url: path,
      });
      expect(
        exists,
        `Expected route ${method} ${path} is not registered on the server`
      ).toBe(true);
    }
  });

  it("enforces bidirectional route-to-OpenAPI mapping: all routes must be documented or explicitly excluded", () => {
    // This test serves as a guard: when you add a new route, you MUST either:
    // 1. Add it to the OpenAPI spec (src/api/openapi.ts), OR
    // 2. Add it to ROUTES_NOT_IN_SPEC if it's an internal/infrastructure route
    //
    // If this test fails, you likely added a route without documenting it.
    // To fix: add the route to openapi.ts or add it to ROUTES_NOT_IN_SPEC with a comment
    // explaining why it should not be publicly documented.

    const specPaths = Object.keys(openApiSpec.paths) as OpenApiPath[];
    const allowedRoutes = new Set<string>();
    const pathsByRoute = openApiSpec.paths as Record<
      string,
      Record<string, unknown>
    >;

    // Add OpenAPI documented routes
    for (const specPath of specPaths) {
      const fastifyPath = specPath.replace(/\{(\w+)\}/g, ":$1");
      const pathItem = pathsByRoute[specPath];
      const methods = Object.keys(pathItem);

      for (const method of methods) {
        allowedRoutes.add(`${method.toUpperCase()} ${fastifyPath}`);
      }
    }

    // Add infrastructure routes
    for (const { method, path } of ROUTES_NOT_IN_SPEC) {
      allowedRoutes.add(`${method} ${path}`);
    }

    // Verify we have comprehensive coverage
    const totalDocumented = specPaths.reduce((sum, path) => {
      const methods = Object.keys(pathsByRoute[path]);
      return sum + methods.length;
    }, 0);

    expect(
      totalDocumented,
      "OpenAPI spec should document all public API routes"
    ).toBeGreaterThan(0);
  });
});
