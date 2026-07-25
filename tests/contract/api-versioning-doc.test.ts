import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CANONICAL_V1_ROUTES } from "../../src/api/routes/registry.js";
import { openApiSpec } from "../../src/api/openapi.js";

const DOC_PATH = resolve(process.cwd(), "docs/api-versioning.md");

function openApiPathToMount(path: string): string {
  return path
    .replace(/\{wallet\}/g, ":wallet")
    .replace(/\{address\}/g, ":address")
    .replace(/\{id\}/g, ":id")
    .replace(/\{marketId\}/g, ":marketId");
}

describe("api-versioning.md matches route mounts", () => {
  const doc = readFileSync(DOC_PATH, "utf8");

  it("documents every canonical /v1 route from the registry", () => {
    for (const route of CANONICAL_V1_ROUTES) {
      expect(doc, `missing ${route.method} ${route.path}`).toContain(
        route.path
      );
      expect(doc, `missing method for ${route.path}`).toContain(route.method);
    }
  });

  it("includes the single-market positions route added in positions router", () => {
    expect(doc).toContain("/v1/wallets/:wallet/positions/:marketId");
  });

  it("matches OpenAPI path keys (converted to Fastify mount paths)", () => {
    const openApiPaths = Object.keys(openApiSpec.paths).map(openApiPathToMount);
    const registryPaths = CANONICAL_V1_ROUTES.map((route) => route.path).filter(
      (path) => path !== "/v1/openapi.json"
    );

    for (const path of registryPaths) {
      expect(openApiPaths, `OpenAPI missing ${path}`).toContain(path);
    }
  });

  it("registry route count matches documented table rows", () => {
    const tableRows = doc
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("| GET") ||
          line.startsWith("| POST") ||
          line.startsWith("| PATCH")
      );
    expect(tableRows.length).toBe(CANONICAL_V1_ROUTES.length);
  });
});
