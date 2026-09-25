import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * #985 — Husky / tsc-files must type-check the matching and auth paths that
 * live under apps/ (and packages/), not just src/. The root tsconfig only
 * `include`s src/**, so routing every staged file through the default
 * tsc-files config let type errors in apps/** slip past the pre-commit gate.
 * These tests fail if that coverage or the fail-fast behaviour regresses.
 */

const ROOT = process.cwd();
const packageJson = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf8")
) as { "lint-staged": Record<string, string[]> };
const preCommit = readFileSync(resolve(ROOT, ".husky/pre-commit"), "utf8");
// Executable lines only — drop `#` comment lines so prose mentioning the old
// `|| true` anti-pattern doesn't trip the scan below.
const preCommitCode = preCommit
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("lint-staged configuration (#985)", () => {
  const lintStaged = packageJson["lint-staged"];

  it("type-checks staged apps/ and packages/ TypeScript against apps/tsconfig.json", () => {
    const entry = lintStaged["{apps,packages}/**/*.ts"];
    expect(entry).toBeDefined();
    expect(
      entry.some(
        (cmd) =>
          cmd.includes("tsc-files") &&
          cmd.includes("apps/tsconfig.json") &&
          cmd.includes("--noEmit")
      )
    ).toBe(true);
  });

  it("still type-checks staged TypeScript generally", () => {
    const entry = lintStaged["*.ts"];
    expect(entry).toBeDefined();
    expect(entry.some((cmd) => cmd.includes("tsc-files"))).toBe(true);
  });

  it("keeps the Prisma schema format + validate gate", () => {
    const entry = lintStaged["prisma/schema.prisma"];
    expect(entry).toEqual(
      expect.arrayContaining(["prisma format", "prisma validate"])
    );
  });
});

describe("pre-commit hook (#985)", () => {
  it("aborts on the first failing check (set -e)", () => {
    expect(preCommitCode).toMatch(/^set -e$/m);
  });

  it("runs lint-staged", () => {
    expect(preCommitCode).toMatch(/lint-staged/);
  });

  it("does not swallow any check with `|| true`", () => {
    expect(preCommitCode).toMatch(/prettier --check apps\/ packages\//);
    expect(preCommitCode).not.toMatch(/\|\|\s*true/);
  });

  it("fails the commit (non-zero exit) when apps/ or packages/ formatting is off", () => {
    // the prettier --check branch must lead to an explicit `exit 1`, not `true`
    const checkBlock = preCommitCode.slice(
      preCommitCode.indexOf("prettier --check")
    );
    expect(checkBlock).toMatch(/exit 1/);
  });
});
