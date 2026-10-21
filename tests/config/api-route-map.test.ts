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

/**
 * Returns, for every route plugin file (excluding metrics.ts and legacy.ts)
 * that declares at least one HTTP method handler, whether ALL of its routes
 * resolve to /v1-prefixed paths in sourceRoutes().
 *
 * A file "has a /v1 prefix" when every route it contributes to sourceRoutes()
 * starts with /v1 — either because the file is registered inside the /v1
 * Fastify prefix block in index.ts, or because it hardcodes /v1 in its paths
 * (e.g. wallet.ts).
 *
 * Files whose routes all resolve to /v1/... pass the invariant.
 * Files with any route not starting with /v1 are returned as offenders.
 */
function routePluginBasePathCheck(): {
  file: string;
  routes: string[];
  allV1: boolean;
}[] {
  const declaration =
    /\.(get|post|put|patch|delete)\s*(?:<[^()]*?>)?\(\s*["`]([^"`]+)["`]/g;
  const results: { file: string; routes: string[]; allV1: boolean }[] = [];

  for (const file of readdirSync(resolve(ROOT, ROUTES_DIR))) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    if (file === "legacy.ts" || file === "metrics.ts") continue;

    const source = read(join(ROUTES_DIR, file));
    const basePath = source.match(/basePath:\s*"([^"]+)"/)?.[1];

    const fileRoutes: string[] = [];
    declaration.lastIndex = 0;
    for (const [, method, rawPath] of source.matchAll(declaration)) {
      const path = rawPath.replace("${basePath}", basePath ?? "");
      const mounted =
        path.startsWith("/v1/") || file === "metrics.ts" ? path : `/v1${path}`;
      fileRoutes.push(`${method.toUpperCase()} ${mounted}`);
    }

    if (fileRoutes.length === 0) continue;

    const allV1 = fileRoutes.every((r) => r.split(" ")[1].startsWith("/v1"));
    results.push({ file, routes: fileRoutes, allV1 });
  }
  return results;
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

  it("declares legacy aliases as structured, non-packed paths", () => {
    for (const { method, path, legacyAliases } of CANONICAL_V1_ROUTES) {
      if (!legacyAliases) continue;
      expect(Array.isArray(legacyAliases), `${method} ${path}`).toBe(true);
      for (const alias of legacyAliases) {
        expect(alias, `${method} ${path}`).not.toContain(",");
        expect(alias.trim(), `${method} ${path}`).toBe(alias);
        expect(alias.startsWith("/"), `${method} ${path}: ${alias}`).toBe(
          true
        );
      }
    }
  });

  it("every route-declaring plugin (except metrics.ts and legacy.ts) has a basePath starting with /v1", () => {
    const offenders: string[] = [];
    for (const { file, routes, allV1 } of routePluginBasePathCheck()) {
      if (!allV1) {
        const bad = routes.filter((r) => !r.split(" ")[1].startsWith("/v1"));
        offenders.push(`${file}: routes not under /v1 — ${bad.join(", ")}`);
      }
    }
    expect(
      offenders,
      `Route plugin(s) with routes outside /v1: ${offenders.join("; ")}`
    ).toHaveLength(0);
  });
});
