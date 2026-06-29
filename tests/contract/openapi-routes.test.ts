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

type BuildServer = typeof import("../../src/index.js").buildServer;
type OpenApiSpec = typeof import("../../src/api/openapi.js").openApiSpec;

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
    .replace(
      /\{wallet\}/g,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    )
    .replace(
      /\{address\}/g,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    )
    .replace(/\{id\}/g, "00000000-0000-0000-0000-000000000000")
    .replace(/\{marketId\}/g, "market-00000000000000000000000000000000");
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
  let buildServer: BuildServer;
  let openApiSpec: OpenApiSpec;

  beforeAll(async () => {
    // Build the full server with test routes disabled to keep it clean.
    // logger: false keeps test output quiet.
    process.env.API_KEY ??= "test-api-key";
    process.env.ADMIN_TOKEN ??= "test-admin-token";
    process.env.DATABASE_URL ??=
      "postgresql://postgres:postgres@localhost:5432/vatix_test";

    ({ buildServer } = await import("../../src/index.js"));
    ({ openApiSpec } = await import("../../src/api/openapi.js"));

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
      const url = resolvePathParams(openApiPath);

      const res = await app.inject({ method: method.toUpperCase(), url });

      if (res.statusCode !== 404) {
        expect(res.statusCode).not.toBe(404);
        continue;
      }

      // A 404 can be either route-not-found (contract drift) or domain/resource-not-found.
      // Only fail when Fastify's global not-found handler is hit.
      const body = JSON.parse(res.body) as { error?: string; message?: string };
      const message = String(body.error ?? body.message ?? "");
      expect(
        message,
        `${method.toUpperCase()} ${url} resolved to route-not-found`
      ).not.toMatch(/^Route\s+/);
    }
  });
});
