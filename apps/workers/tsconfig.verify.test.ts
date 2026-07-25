import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, relative, join } from "node:path";

const WORKERS_ROOT = resolve(process.cwd(), "apps/workers");
const TSCONFIG_PATH = resolve(WORKERS_ROOT, "tsconfig.json");

function listTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath));
    } else if (entry.endsWith(".ts")) {
      files.push(relative(WORKERS_ROOT, fullPath));
    }
  }

  return files.sort();
}

function pathMatchesInclude(file: string, includeGlobs: string[]): boolean {
  const normalized = file.replace(/\\/g, "/");
  return includeGlobs.some((pattern) => {
    const glob = pattern
      .replace(/^\.\//, "")
      .replace(/\*\*/g, "§")
      .replace(/\*/g, "[^/]*")
      .replace(/§/g, ".*");
    const regex = new RegExp(`^${glob}$`);
    return regex.test(normalized);
  });
}

describe("workers tsconfig apps (min-034)", () => {
  it("defines apps/workers/tsconfig.json extending apps/tsconfig.json", () => {
    const tsconfig = JSON.parse(readFileSync(TSCONFIG_PATH, "utf8"));
    expect(tsconfig.extends).toBe("../tsconfig.json");
    expect(tsconfig.include).toContain("./src/**/*.ts");
  });

  it("includes every workers source file", () => {
    const tsconfig = JSON.parse(readFileSync(TSCONFIG_PATH, "utf8"));
    const include = tsconfig.include as string[];
    const sourceFiles = listTypeScriptFiles(resolve(WORKERS_ROOT, "src"));

    for (const file of sourceFiles) {
      expect(
        pathMatchesInclude(file, include),
        `expected ${file} to be covered by workers tsconfig include`
      ).toBe(true);
    }
  });

  it("is covered by the parent apps/tsconfig.json glob", () => {
    const appsTsconfig = JSON.parse(
      readFileSync(resolve(process.cwd(), "apps/tsconfig.json"), "utf8")
    );
    expect(appsTsconfig.include).toContain("../apps/**/*.ts");

    const sampleWorkerFile = "workers/src/routes/ready.ts";
    const glob = "../apps/**/*.ts"
      .replace(/^\.\.\/apps\//, "")
      .replace(/\*\*/g, "§")
      .replace(/\*/g, "[^/]*")
      .replace(/§/g, ".*");
    expect(new RegExp(`^${glob}$`).test(sampleWorkerFile)).toBe(true);
  });
});
