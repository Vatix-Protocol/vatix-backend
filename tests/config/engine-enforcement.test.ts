/**
 * Engine / toolchain parity guard (issue #986).
 *
 * "Dev on 20 vs CI 22 hides breakage." These tests fail if the pinned Node
 * major ever drifts apart between .nvmrc, package.json engines, the CI
 * workflow, and the Dockerfile — i.e. if the gap this issue closed returns.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateEngines,
  parseVersion,
  satisfiesMinRange,
} from "../../scripts/check-engines.js";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const pkg = JSON.parse(read("package.json")) as {
  engines: { node: string; pnpm: string };
  scripts: Record<string, string>;
};
const nvmrc = read(".nvmrc").trim();
const npmrc = read(".npmrc");
const ciWorkflow = read(".github/workflows/ci.yml");
const dockerfile = read("Dockerfile");

describe("engine pin: single source of truth", () => {
  it(".nvmrc pins a bare Node major", () => {
    expect(nvmrc).toMatch(/^\d+$/);
  });

  it("package.json engines.node floor matches the .nvmrc major", () => {
    expect(parseVersion(pkg.engines.node.replace(/[^\d.]/g, ""))[0]).toBe(
      Number(nvmrc)
    );
  });

  it("package.json engines.pnpm floor is >=10 (matches CI pnpm)", () => {
    expect(parseVersion(pkg.engines.pnpm.replace(/[^\d.]/g, ""))[0]).toBe(10);
  });

  it("CI reads the Node version from .nvmrc (not a hard-coded literal)", () => {
    expect(ciWorkflow).toMatch(/node-version-file:\s*["']?\.nvmrc["']?/);
    expect(ciWorkflow).not.toMatch(/node-version:\s*["']?\d/);
  });

  it("Dockerfile NODE_VERSION major matches .nvmrc", () => {
    const arg = dockerfile.match(/ARG NODE_VERSION=(\d+)/);
    expect(arg).not.toBeNull();
    expect(Number(arg![1])).toBe(Number(nvmrc));
  });
});

describe("engine enforcement wiring", () => {
  it(".npmrc enables engine-strict so pnpm install fail-fasts", () => {
    expect(npmrc).toMatch(/engine-strict\s*=\s*true/);
  });

  it("package.json exposes the engines:check script", () => {
    expect(pkg.scripts["engines:check"]).toContain("scripts/check-engines.ts");
  });

  it("CI runs pnpm engines:check", () => {
    expect(ciWorkflow).toMatch(/pnpm engines:check/);
  });

  it("docs/engine-enforcement.md documents the policy", () => {
    const doc = read("docs/engine-enforcement.md");
    expect(doc).toMatch(/engine-strict/);
    expect(doc).toMatch(/engines:check/);
    expect(doc).toMatch(/\.nvmrc/);
  });
});

describe("check-engines helpers", () => {
  it("satisfiesMinRange handles >= ranges by major/minor/patch", () => {
    expect(satisfiesMinRange("22.0.0", ">=22.0.0")).toBe(true);
    expect(satisfiesMinRange("24.4.1", ">=22.0.0")).toBe(true);
    expect(satisfiesMinRange("20.11.0", ">=22.0.0")).toBe(false);
    expect(satisfiesMinRange("10.15.0", ">=10.0.0")).toBe(true);
    expect(satisfiesMinRange("9.9.9", ">=10.0.0")).toBe(false);
  });

  it("evaluateEngines is clean when every source agrees", () => {
    const result = evaluateEngines({
      packageJson: JSON.stringify({
        engines: { node: ">=22.0.0", pnpm: ">=10.0.0" },
      }),
      nvmrc: "22\n",
      ciWorkflow: 'node-version-file: ".nvmrc"',
      nodeVersion: "22.4.1",
      pnpmVersion: "10.15.0",
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("evaluateEngines flags a .nvmrc / engines.node mismatch", () => {
    const result = evaluateEngines({
      packageJson: JSON.stringify({
        engines: { node: ">=22.0.0", pnpm: ">=10.0.0" },
      }),
      nvmrc: "20\n",
      ciWorkflow: 'node-version-file: ".nvmrc"',
      nodeVersion: "20.11.0",
      pnpmVersion: "10.15.0",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(
      /disagrees with package\.json engines\.node/
    );
  });

  it("evaluateEngines flags a hard-coded CI Node major that drifts from .nvmrc", () => {
    const result = evaluateEngines({
      packageJson: JSON.stringify({
        engines: { node: ">=22.0.0", pnpm: ">=10.0.0" },
      }),
      nvmrc: "22\n",
      ciWorkflow: 'node-version: "20"',
      nodeVersion: "22.4.1",
      pnpmVersion: "10.15.0",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/CI workflow Node major/);
  });

  it("evaluateEngines flags a running pnpm below the engines floor", () => {
    const result = evaluateEngines({
      packageJson: JSON.stringify({
        engines: { node: ">=22.0.0", pnpm: ">=10.0.0" },
      }),
      nvmrc: "22\n",
      ciWorkflow: 'node-version-file: ".nvmrc"',
      nodeVersion: "22.4.1",
      pnpmVersion: "8.15.0",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/pnpm 8\.15\.0 does not satisfy/);
  });
});
