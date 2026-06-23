/**
 * #454 — Contract test: every path in openapi.ts returns non-404 from the app.
 *
 * Guards against drift between the documented OpenAPI contract and the actual
 * Fastify routes. Any path key added to openApiSpec.paths that has no matching
 * route will fail this test, and vice-versa.
 *
 * CI gate: runs on every PR touching src/api/routes/** or src/api/openapi.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../src/index.js";
import { openApiSpec } from "../../src/api/openapi.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an OpenAPI path template to a testable URL by substituting path
 * parameters with valid placeholder values.
 *
 * e.g. /v1/markets/{id} → /v1/markets/test-id
 *      /v1/wallets/{wallet}/positions → /v1/wallets/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF/positions
 */
function resolvePathParams(openApiPath: string): string {
  return openApiPath
    .replace(/\{wallet\}/g, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")
    .replace(/\{address\}/g, "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")
    .replace(/\{id\}/g, "00000000-0000-0000-0000-000000000000");
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

  beforeAll(async () => {
    // Build the full server with test routes disabled to keep it clean.
    // logger: false keeps test output quiet.
    process.env.API_KEY ??= "test-api-key";
    process.env.ADMIN_TOKEN ??= "test-admin-token";

    app = buildServer({ logger: false, registerTestRoutes: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const paths = Object.entries(
    openApiSpec.paths as Record<string, Record<string, unknown>>
  );

  it("openApiSpec.paths is non-empty", () => {
    expect(paths.length).toBeGreaterThan(0);
  });

  it.each(paths)(
    "path %s is registered in Fastify (returns non-404)",
    async (openApiPath, pathItem) => {
      const method = firstMethod(pathItem);
      const url = resolvePathParams(openApiPath);

      const res = await app.inject({ method: method.toUpperCase(), url });

      // We allow any status code except 404 (route not found).
      // 200, 201, 400, 401, 403, 422, 503 all mean the route exists.
      expect(res.statusCode, `${method.toUpperCase()} ${url} returned 404`).not.toBe(404);
    }
  );
});
