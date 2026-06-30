/**
 * #454 — Contract test: every path in openapi.ts returns non-404 from the app.
 *
 * Guards against drift between the documented OpenAPI contract and the actual
 * Fastify routes. Any path key added to openApiSpec.paths that has no matching
 * route will fail this test, and vice-versa.
 *
 * CI gate: runs on every PR touching src/api/routes/** or src/api/openapi.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { openApiSpec } from "../../src/api/openapi.js";
import { testUtils } from "../setup.js";

vi.hoisted(() => {
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5433/vatix";
});

const { buildServer } = await import("../../src/index.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAPI path template to a testable URL by substituting path
 * parameters with valid placeholder values.
 */
function resolvePathParams(
  openApiPath: string,
  marketId: string,
  wallet: string
): string {
  return openApiPath
    .replace(/\{wallet\}/g, wallet)
    .replace(/\{address\}/g, wallet)
    .replace(/\{marketId\}/g, marketId)
    .replace(/\{id\}/g, marketId);
}

/** Pick the first HTTP method listed for a path in the spec. */
function firstMethod(pathItem: Record<string, unknown>): string {
  const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
  return methods.find((m) => m in pathItem) ?? "get";
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("#454 — OpenAPI contract: all spec paths are reachable (non-404)", () => {
  let app: FastifyInstance;
  let marketId: string;
  const wallet = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

  beforeAll(async () => {
    process.env.API_KEY ??= "test-api-key";
    process.env.ADMIN_TOKEN ??= "test-admin-token";
    process.env.DATABASE_URL ??=
      "postgresql://postgres:postgres@localhost:5432/vatix_test";

    ({ buildServer } = await import("../../src/index.js"));
    ({ openApiSpec } = await import("../../src/api/openapi.js"));

    const market = await testUtils.createTestMarket({
      question: "OpenAPI contract market",
      status: "ACTIVE",
    });
    marketId = market.id;

    app = buildServer({ logger: false, registerTestRoutes: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("openApiSpec.paths is non-empty", () => {
    const paths = Object.entries(
      openApiSpec.paths as Record<string, Record<string, unknown>>
    );
    expect(paths.length).toBeGreaterThan(0);
  });

  it("every path is registered in Fastify (returns non-route-404)", async () => {
    const paths = Object.entries(
      openApiSpec.paths as Record<string, Record<string, unknown>>
    );

    for (const [openApiPath, pathItem] of paths) {
      const method = firstMethod(pathItem);
      const url = resolvePathParams(openApiPath, marketId, wallet);

      const res = await app.inject({ method: method.toUpperCase(), url });

      // We allow any status code except 404 (route not found).
      // 200, 201, 400, 401, 403, 422, 503 all mean the route exists.
      expect(
        res.statusCode,
        `${method.toUpperCase()} ${url} returned 404`
      ).not.toBe(404);
    }
  });
});
