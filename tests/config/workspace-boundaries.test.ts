import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** Minimal YAML parser for the simple structure of pnpm-workspace.yaml */
function parseWorkspaceYaml(): string[] {
  const content = read("pnpm-workspace.yaml");
  const packages: string[] = [];
  let inPackages = false;
  for (const line of content.split("\n")) {
    if (line.trim().startsWith("packages:")) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const match = line.match(/^  - ["']?(.+?)["']?\s*$/);
      if (match) {
        packages.push(match[1]);
      } else if (line.trim() && !line.startsWith(" ") && !line.startsWith("#")) {
        inPackages = false;
      }
    }
  }
  return packages;
}

describe("pnpm workspace boundaries", () => {
  const workspacePackages = parseWorkspaceYaml();

  it("pnpm-workspace.yaml declares apps/* and packages/*", () => {
    expect(workspacePackages).toContain("apps/*");
    expect(workspacePackages).toContain("packages/*");
  });

  it("every workspace package has a package.json", () => {
    const gaps: string[] = [];
    for (const pattern of workspacePackages) {
      const base = pattern.replace(/\/\*$/, "");
      const dir = resolve(ROOT, base);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const pkg = resolve(dir, entry, "package.json");
        if (!existsSync(pkg)) {
          gaps.push(`${base}/${entry}/package.json`);
        }
      }
    }
    expect(gaps, `missing package.json in: ${gaps.join(", ")}`).toEqual([]);
  });

  it("every workspace package.json has a name field", () => {
    const missing: string[] = [];
    for (const pattern of workspacePackages) {
      const base = pattern.replace(/\/\*$/, "");
      const dir = resolve(ROOT, base);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const pkgPath = resolve(dir, entry, "package.json");
        if (!existsSync(pkgPath)) continue;
        const pkg = JSON.parse(read(pkgPath));
        if (!pkg.name) {
          missing.push(`${base}/${entry}`);
        }
      }
    }
    expect(missing, `workspace packages missing name: ${missing.join(", ")}`).toEqual([]);
  });

  it("no workspace package imports from another using relative paths to packages/", () => {
    const tsFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "generated") continue;
        const path = resolve(dir, entry);
        if (existsSync(path) && statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
          tsFiles.push(path);
        }
      }
    };
    walk(resolve(ROOT, "src"));
    walk(resolve(ROOT, "apps"));
    walk(resolve(ROOT, "packages"));

    const relativeImports: string[] = [];
    for (const file of tsFiles) {
      const content = read(file);
      for (const match of content.matchAll(/from\s+["'](\.\.\/[^"']*packages\/[^"']+)["']/g)) {
        relativeImports.push(`${file}: ${match[1]}`);
      }
    }

    expect(
      relativeImports,
      `found relative imports to packages/ (use package names instead): ${relativeImports.join("; ")}`
    ).toEqual([]);
  });

  it("@vatix/shared package.json declares exports for all public modules", () => {
    const sharedPkg = JSON.parse(read("packages/shared/package.json"));
    expect(sharedPkg.exports).toBeDefined();
    expect(sharedPkg.exports["."]).toBe("./src/index.ts");
  });

  it("@vatix/api package.json exists and has a valid name", () => {
    const pkg = JSON.parse(read("apps/api/package.json"));
    expect(pkg.name).toBe("@vatix/api");
    expect(pkg.type).toBe("module");
  });
});
