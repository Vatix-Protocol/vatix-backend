import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vitestConfig from "../vitest.config";

/**
 * #1159 — the coverage gate must actually gate. Vitest reads every key under
 * `coverage.thresholds` other than the four metric names as a file glob, so
 * the Jest-style `thresholds.global` this config used to have matched no files
 * and enforced nothing. These tests fail if the gate is disabled that way
 * again, or if the CI unit-test step stops collecting coverage.
 */

const coverage = vitestConfig.test?.coverage as {
  provider?: string;
  include?: string[];
  exclude?: string[];
  thresholds?: Record<string, unknown>;
};
const METRICS = ["statements", "branches", "functions", "lines"] as const;

describe("vitest coverage gates (#1159)", () => {
  it("uses the v8 provider", () => {
    expect(coverage.provider).toBe("v8");
  });

  it("sets a numeric floor for every metric directly under thresholds", () => {
    const thresholds = coverage.thresholds ?? {};
    expect(Object.keys(thresholds).sort()).toEqual([...METRICS].sort());
    for (const metric of METRICS) {
      const floor = thresholds[metric];
      expect(typeof floor, metric).toBe("number");
      expect(floor as number).toBeGreaterThan(0);
      expect(floor as number).toBeLessThanOrEqual(100);
    }
  });

  it("measures all application source, excluding tests and generated code", () => {
    expect(coverage.include).toEqual(
      expect.arrayContaining([
        "src/**/*.ts",
        "apps/**/*.ts",
        "packages/**/*.ts",
      ])
    );
    expect(coverage.exclude).toEqual(
      expect.arrayContaining(["**/*.test.ts", "src/generated/**"])
    );
  });

  it("collects coverage in the CI unit-test step so the gate runs on every PR", () => {
    const ci = readFileSync(
      resolve(process.cwd(), ".github/workflows/ci.yml"),
      "utf8"
    );
    const step = ci.slice(ci.indexOf("- name: Run unit tests (with coverage)"));
    const run = step.slice(0, step.indexOf("\n      - name:"));
    expect(run).toMatch(/vitest run .*--coverage/);
  });
});
