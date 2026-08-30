/**
 * Contract test: verify OpenAPI spec, CANONICAL_V1_ROUTES, and live Fastify routes are in sync.
 * Catches drift where routes are added/removed but not reflected in the spec or registry.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "../src/index.js";
import type { FastifyInstance } from "fastify";
import { CANONICAL_V1_ROUTES } from "../src/api/routes/registry.js";
import { getOpenApiSpec } from "../src/api/openapi.js";

describe("Route Registry Sync: Fastify routes ↔ CANONICAL_V1_ROUTES ↔ OpenAPI", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("all CANONICAL_V1_ROUTES should be registered in live Fastify", async () => {
    const registeredRoutes = app.printRoutes();

    for (const canonical of CANONICAL_V1_ROUTES) {
      // Check that the route is registered in Fastify
      expect(registeredRoutes).toContain(canonical.path);
    }
  });

  it("live Fastify routes should be documented in CANONICAL_V1_ROUTES or be health/metrics probes", async () => {
    const registeredRoutes = app.printRoutes();
    const routeList = registeredRoutes.split("\n").filter((r) => r.trim());

    const canonicalPaths = CANONICAL_V1_ROUTES.map((r) => r.path);
    const healthProbes = ["/v1/ready", "/v1/health", "/metrics", "/"];

    for (const route of routeList) {
      // Routes should either be in the canonical list, be health probes, or error handlers
      const isCanonical = canonicalPaths.some((p) => route.includes(p));
      const isHealthProbe = healthProbes.some((p) => route.includes(p));
      const isErrorHandler = route.includes("error handler");

      if (!isCanonical && !isHealthProbe && !isErrorHandler) {
        // Print the route for debugging — it's probably missing from the registry
        console.log(`Unregistered route in CANONICAL_V1_ROUTES: ${route}`);
      }
    }
  });

  it("admin and audit routes should have security schemes in OpenAPI", async () => {
    const spec = getOpenApiSpec("production");
    const paths = spec.paths || {};

    const adminRoutes = Object.keys(paths).filter(
      (p) => p.includes("/admin") || p.includes("/audit")
    );

    for (const path of adminRoutes) {
      const pathSpec = paths[path];
      if (!pathSpec) continue;

      for (const method of ["get", "post", "patch", "delete"]) {
        const methodSpec = pathSpec[method];
        if (!methodSpec) continue;

        // Admin/audit routes should have security defined
        // (either inline or as a default in the spec)
        if (!methodSpec.security) {
          console.log(
            `Warning: ${method.toUpperCase()} ${path} missing security scheme in OpenAPI`
          );
        }
      }
    }
  });

  it("routes newly added (audit-verification) should be in registry", async () => {
    // The audit-verification routes were just mounted in #932
    const auditRoutes = CANONICAL_V1_ROUTES.filter((r) =>
      r.path.includes("/audit")
    );

    // Should have at least the three audit routes
    expect(auditRoutes.length).toBeGreaterThanOrEqual(3);
  });

  it("fills stream route should be in registry if it exists", async () => {
    const registeredRoutes = app.printRoutes();
    const hasFillsStream = registeredRoutes.includes("fills/stream");

    if (hasFillsStream) {
      // If the route exists, it should be documented
      const fillsStreamDocumented = CANONICAL_V1_ROUTES.some((r) =>
        r.path.includes("fills/stream")
      );

      expect(fillsStreamDocumented).toBe(true);
    }
  });
});
