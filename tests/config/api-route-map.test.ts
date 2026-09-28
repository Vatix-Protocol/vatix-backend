import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CANONICAL_V1_ROUTES } from "../../src/api/routes/registry.js";

/**
 * Keeps the route map in apps/api/README.md in sync with the routes the API
 * actually registers. Routes are read statically from the route plugins so
 * this test does not need to boot the server or its dependencies.
 */

const ROOT = process.cwd();
const README_PATH = "apps/api/README.md";
const ROUTES_DIR = "src/api/routes";

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** `METHOD /path` for every row of the README route-map tables. */
function readmeRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  const row =
    /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|.*`((?:src)\/[^`]+\.ts)`/gm;
  for (const [, method, path, handler] of read(README_PATH).matchAll(row)) {
    routes.set(`${method} ${path}`, handler);
  }
  return routes;
}

/** `METHOD /path` for every route declared by the API's route plugins. */
function sourceRoutes(): Set<string> {
  const routes = new Set<string>();
  const declaration =
    /\.(get|post|put|patch|delete)\s*(?:<[^()]*?>)?\(\s*["`]([^"`]+)["`]/g;

  for (const file of readdirSync(resolve(ROOT, ROUTES_DIR))) {
    // legacy.ts only registers deprecated aliases, documented as prose.
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    if (file === "legacy.ts") continue;
    const source = read(join(ROUTES_DIR, file));
    const basePath = source.match(/basePath:\s*"([^"]+)"/)?.[1];

    for (const [, method, rawPath] of source.matchAll(declaration)) {
      const path = rawPath.replace("${basePath}", basePath ?? "");
      // Plugins are mounted in the /v1 scope except the ones that set their
      // own prefix (wallet) and the unversioned Prometheus endpoint.
      const mounted =
        path.startsWith("/v1/") || file === "metrics.ts" ? path : `/v1${path}`;
      routes.add(`${method.toUpperCase()} ${mounted}`);
    }
  }

  const index = read("src/index.ts");
  for (const [, scope, path] of index.matchAll(
    /\b(v1|server)\.get\(\s*"([^"]+)"/g
  )) {
    if (path.startsWith("/test/")) continue;
    routes.add(`GET ${scope === "v1" ? `/v1${path}` : path}`);
  }
  return routes;
}

describe("API README route map", () => {
  it("lists exactly the routes the API registers", () => {
    const documented = [...readmeRoutes().keys()].sort();
    const registered = [...sourceRoutes()].sort();

    expect(registered.length).toBeGreaterThan(0);
    expect(documented).toEqual(registered);
  });

  it("includes every canonical /v1 route from the registry", () => {
    const documented = readmeRoutes();
    for (const { method, path } of CANONICAL_V1_ROUTES) {
      expect(documented.has(`${method} ${path}`), `${method} ${path}`).toBe(
        true
      );
    }
  });

  it("points every route at a handler file that exists", () => {
    for (const [route, handler] of readmeRoutes()) {
      expect(existsSync(resolve(ROOT, handler)), `${route}: ${handler}`).toBe(
        true
      );
    }
  });

  it("only links to files that exist", () => {
    const markdown = read(README_PATH);
    for (const [, link] of markdown.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = resolve(ROOT, dirname(README_PATH), link);
      expect(existsSync(target), link).toBe(true);
    }
  });
});
