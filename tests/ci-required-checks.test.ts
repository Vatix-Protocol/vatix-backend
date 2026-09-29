import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * #1158 — CONTRIBUTING.md lists the steps of the required CI / Backend job so
 * contributors can reproduce them locally. These tests fail when a step is
 * added to or renamed in `.github/workflows/ci.yml` without updating that
 * list, so the documented gate can't silently drift from the real one.
 */

const ROOT = process.cwd();
const ciWorkflow = readFileSync(
  resolve(ROOT, ".github/workflows/ci.yml"),
  "utf8"
);
const contributing = readFileSync(resolve(ROOT, "CONTRIBUTING.md"), "utf8");

/** Runner/toolchain plumbing that has no local equivalent to document. */
const SETUP_STEPS = new Set([
  "Checkout code",
  "Setup Node.js",
  "Setup pnpm",
  "Get pnpm store directory",
  "Setup pnpm cache",
  "Create shadow database",
]);

const stepNames = [...ciWorkflow.matchAll(/^\s+- name: (.+)$/gm)].map((m) =>
  m[1].trim().replace(/^["']|["']$/g, "")
);

const requiredChecksSection = contributing.slice(
  contributing.indexOf("## CI Required Checks")
);

describe("CI required checks documentation (#1158)", () => {
  it("documents a CI Required Checks section linked from the table of contents", () => {
    expect(contributing).toContain("## CI Required Checks");
    expect(contributing).toContain("(#ci-required-checks)");
  });

  it("lists every Backend job step from ci.yml", () => {
    const checks = stepNames.filter((name) => !SETUP_STEPS.has(name));
    expect(checks.length).toBeGreaterThan(0);
    for (const name of checks) {
      expect(requiredChecksSection, `missing CI step "${name}"`).toContain(
        `| ${name} `
      );
    }
  });

  it("only lists steps that still exist in ci.yml", () => {
    const listed = [
      ...requiredChecksSection.matchAll(/^\|\s*\d+\s*\|\s*([^|]+?)\s*\|/gm),
    ].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed) {
      expect(stepNames, `stale CI step "${name}"`).toContain(name);
    }
  });
});
